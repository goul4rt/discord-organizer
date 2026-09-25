// Organizes the servers of YOUR Discord account into folders by topic.
// WARNING: uses a user token (selfbot) — against Discord's ToS, risk of ban.
// Commands: scan, report, apply, notify, notify-reset, restore, test — see the README.

import fs from 'node:fs';
import assert from 'node:assert';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

const API = 'https://discord.com/api/v10';
const TEXT_TYPES = new Set([0, 5]); // text, announcements
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

async function discord(path, init = {}) {
    for (;;) {
        // Human-ish pace: random 1.5–4s between requests. Selfbot: fewer and slower means lower risk.
        await sleep(1500 + Math.random() * 2500);
        const res = await fetch(API + path, {
            ...init,
            headers: { Authorization: process.env.DISCORD_TOKEN, 'Content-Type': 'application/json' },
        });
        if (res.status === 429) {
            // 429 = Discord noticed. Wait twice as long as asked instead of pushing it.
            const { retry_after = 5 } = await res.json();
            console.error(`  rate limited, waiting ${retry_after}s`);
            await sleep(retry_after * 2000);
            continue;
        }
        if (res.status === 401) throw new Error('Invalid token (401). Check DISCORD_TOKEN in .env');
        if (!res.ok) return null; // no access to the channel, etc.
        return res.json();
    }
}

// Snowflake -> timestamp: tells the last activity without reading any message.
const snowflakeMs = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);
const daysSince = (ms) => Math.floor((Date.now() - ms) / 86_400_000);

async function collect() {
    const guilds = await discord('/users/@me/guilds?with_counts=true');
    const out = [];
    for (const [i, g] of guilds.entries()) {
        console.error(`[${i + 1}/${guilds.length}] ${g.name}`);
        const channels = (await discord(`/guilds/${g.id}/channels`)) ?? [];
        const cats = Object.fromEntries(channels.filter((c) => c.type === 4).map((c) => [c.id, c.name]));
        const text = channels
            .filter((c) => TEXT_TYPES.has(c.type))
            .sort((a, b) => (BigInt(b.last_message_id ?? 0) > BigInt(a.last_message_id ?? 0) ? 1 : -1));

        const last = text.filter((c) => c.last_message_id).map((c) => snowflakeMs(c.last_message_id));
        const week = Date.now() - 7 * 86_400_000;

        // Message sample: a single try per server (a burst of 403s also draws attention).
        const msgs = text.length ? await discord(`/channels/${text[0].id}/messages?limit=20`) : null;
        const sample = (msgs ?? []).filter((m) => m.content).map((m) => `#${text[0].name}: ${m.content.slice(0, 200)}`);

        out.push({
            id: g.id,
            name: g.name,
            members: g.approximate_member_count,
            online: g.approximate_presence_count,
            days_since_last_message: last.length ? daysSince(Math.max(...last)) : null,
            active_channels_7d: last.filter((t) => t > week).length,
            channels: text.slice(0, 40).map((c) => ({
                name: c.name,
                category: cats[c.parent_id],
                topic: c.topic?.slice(0, 150) || undefined,
            })),
            sample,
        });
    }
    return out;
}

const Plan = z.object({
    folders: z.array(z.object({ name: z.string(), description: z.string() })),
    servers: z.array(
        z.object({
            id: z.string(),
            folder: z.string(),
            what_it_is: z.string(),
            activity: z.enum(['very active', 'active', 'lukewarm', 'dead']),
        })
    ),
});

async function classify(data) {
    const client = new Anthropic();
    const res = await client.messages.stream({
        model: 'claude-opus-5',
        max_tokens: 64000,
        output_config: { format: zodOutputFormat(Plan) },
        messages: [
            {
                role: 'user',
                content: `These are the Discord servers of one person, with channels, topics, a sample of recent messages and activity metrics.

For each server: describe in one sentence what it is / what it is for (what_it_is), and rate its activity from days_since_last_message, active_channels_7d and online.
Then group the servers into folders by topic (e.g. Programming, Games, Work, Crypto, Local communities...). Between 4 and 12 folders, short names (max 20 characters). Dead servers stay in their topic's folder (the activity field already flags them). Every server must be in exactly one folder.
Write folder names, descriptions and what_it_is in the language most of these servers use.

${JSON.stringify(data)}`,
            },
        ],
    }).finalMessage();
    if (res.stop_reason !== 'end_turn' || !res.parsed_output) {
        throw new Error(`Classification failed (stop_reason=${res.stop_reason})`);
    }
    return res.parsed_output;
}

function report(plan, data) {
    const byId = Object.fromEntries(data.map((d) => [d.id, d]));
    let md = `# Your Discord servers\n\n`;
    for (const f of plan.folders) {
        const srv = plan.servers.filter((s) => s.folder === f.name);
        md += `## ${f.name} (${srv.length})\n_${f.description}_\n\n| Server | What it is | Activity | Members | Days since last msg |\n|---|---|---|---|---|\n`;
        for (const s of srv) {
            const d = byId[s.id] ?? {};
            md += `| ${d.name} | ${s.what_it_is} | ${s.activity} | ${d.members ?? '?'} | ${d.days_since_last_message ?? '—'} |\n`;
        }
        md += '\n';
    }
    return md;
}

// Builds Discord's guild_folders: each server in exactly one folder; servers the plan missed stay loose.
export function buildFolders(plan, guildIds) {
    const COLORS = [0x5865f2, 0x57f287, 0xfee75c, 0xeb459e, 0xed4245, 0xf47b67, 0x3498db, 0x9b59b6, 0x1abc9c, 0x95a5a6];
    const valid = new Set(guildIds);
    const used = new Set();
    const folders = plan.folders.map((f, i) => {
        const ids = plan.servers
            .filter((s) => s.folder === f.name && valid.has(s.id) && !used.has(s.id))
            .map((s) => (used.add(s.id), s.id));
        return { id: Math.floor(Math.random() * 2 ** 31), name: f.name.slice(0, 32), color: COLORS[i % COLORS.length], guild_ids: ids };
    }).filter((f) => f.guild_ids.length);
    const loose = guildIds.filter((id) => !used.has(id)).map((id) => ({ id: null, guild_ids: [id] }));
    return [...folders, ...loose];
}

const needToken = () => {
    if (!process.env.DISCORD_TOKEN) throw new Error('Set DISCORD_TOKEN in .env');
};
const cmd = process.argv[2];

if (cmd === 'scan') {
    needToken();
    // Collecting is slow on purpose; reuse data.json if it exists. Delete it to collect again.
    const data = fs.existsSync('data.json') ? readJson('data.json') : await collect();
    fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
    if (!process.env.ANTHROPIC_API_KEY) {
        console.error('data.json saved. No ANTHROPIC_API_KEY: classify data.json yourself (e.g. with Claude Code) into plan.json, then run "report".');
        process.exit(0);
    }
    console.error(`Classifying ${data.length} servers with Claude...`);
    const plan = await classify(data);
    fs.writeFileSync('plan.json', JSON.stringify(plan, null, 2));
    fs.writeFileSync('report.md', report(plan, data));
    console.error('Done: report.md and plan.json. Edit plan.json if you want, then run "apply".');
} else if (cmd === 'report') {
    // Rebuilds report.md from plan.json (handy after editing the plan by hand).
    fs.writeFileSync('report.md', report(readJson('plan.json'), readJson('data.json')));
    console.error('report.md updated.');
} else if (cmd === 'apply') {
    needToken();
    const plan = readJson('plan.json');
    const current = await discord('/users/@me/settings');
    if (!current?.guild_folders) throw new Error('Could not read your current folders — aborting without changing anything.');
    const backup = `backup-folders-${Date.now()}.json`;
    fs.writeFileSync(backup, JSON.stringify(current.guild_folders, null, 2));
    // guild_folders leaves out servers never dragged anywhere (they sit loose at the top); add the ones from data.json.
    const collected = fs.existsSync('data.json') ? readJson('data.json').map((d) => d.id) : [];
    const guildIds = [...new Set([...current.guild_folders.flatMap((f) => f.guild_ids), ...collected])];
    const res = await discord('/users/@me/settings', {
        method: 'PATCH',
        body: JSON.stringify({ guild_folders: buildFolders(plan, guildIds) }),
    });
    if (!res) throw new Error(`Discord rejected the change. Nothing changed; backup at ${backup}`);
    console.error(`Folders applied. Previous layout saved to ${backup} (undo with: node --env-file=.env organize.mjs restore ${backup})`);
} else if (cmd === 'notify' || cmd === 'notify-reset') {
    needToken();
    // notify: mute everything and only notify on direct mentions. notify-reset: back to each server's default.
    const cfg = cmd === 'notify'
        ? { muted: true, message_notifications: 1, suppress_everyone: true, suppress_roles: true }
        : { muted: false, message_notifications: 3, suppress_everyone: false, suppress_roles: false };
    const ids = readJson('data.json').map((d) => d.id);
    // One bulk request (what the official client uses) instead of one per server: smaller footprint.
    const bulk = await discord('/users/@me/guilds/settings', {
        method: 'PATCH',
        body: JSON.stringify({ guilds: Object.fromEntries(ids.map((id) => [id, cfg])) }),
    });
    if (bulk) {
        console.error(`Applied in bulk to ${ids.length} servers.`);
    } else {
        console.error('Bulk request rejected; going one by one, slowly.');
        for (const [i, id] of ids.entries()) {
            const ok = await discord(`/users/@me/guilds/${id}/settings`, { method: 'PATCH', body: JSON.stringify(cfg) });
            console.error(`[${i + 1}/${ids.length}] ${ok ? 'ok' : 'failed'}`);
            if (i % 20 === 19) await sleep(20_000 + Math.random() * 40_000); // long pause every 20
        }
    }
} else if (cmd === 'restore') {
    needToken();
    const guild_folders = readJson(process.argv[3]);
    const res = await discord('/users/@me/settings', { method: 'PATCH', body: JSON.stringify({ guild_folders }) });
    console.error(res ? 'Folders restored.' : 'Restore failed.');
} else if (cmd === 'test') {
    const plan = {
        folders: [{ name: 'Games' }, { name: 'Dev' }, { name: 'Empty' }],
        servers: [
            { id: '1', folder: 'Games' },
            { id: '2', folder: 'Dev' },
            { id: '1', folder: 'Dev' }, // duplicate: stays in the first one only
            { id: '99', folder: 'Dev' }, // not in the account: ignored
        ],
    };
    const f = buildFolders(plan, ['1', '2', '3']);
    assert.deepStrictEqual(f.map((x) => x.guild_ids), [['1'], ['2'], ['3']]);
    assert.strictEqual(f[2].id, null); // '3' stays loose
    assert.strictEqual(f.length, 3); // empty folder dropped
    console.log('ok');
} else {
    console.error('usage: node --env-file=.env organize.mjs scan | report | apply | notify | notify-reset | restore <backup.json> | test');
}
