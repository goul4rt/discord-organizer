// Organiza os servidores da SUA conta do Discord em pastas por tópico.
// ATENÇÃO: usa token de usuário (selfbot) — viola os ToS do Discord, risco de ban.
//
// Comandos: scan, report, apply, notify, notify-reset, restore, test — veja o README.

import fs from 'node:fs';
import assert from 'node:assert';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

const API = 'https://discord.com/api/v10';
const TEXT_TYPES = new Set([0, 5]); // texto, anúncios
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function discord(path, init = {}) {
    for (;;) {
        // Ritmo humano: 1,5–4s aleatório entre requisições. Selfbot: quanto menos e mais espaçado, menor o risco.
        await sleep(1500 + Math.random() * 2500);
        const res = await fetch(API + path, {
            ...init,
            headers: { Authorization: process.env.DISCORD_TOKEN, 'Content-Type': 'application/json' },
        });
        if (res.status === 429) {
            // 429 = o Discord notou. Espera o dobro do pedido para não insistir.
            const { retry_after = 5 } = await res.json();
            console.error(`  rate limit, esperando ${retry_after}s`);
            await sleep(retry_after * 2000);
            continue;
        }
        if (res.status === 401) throw new Error('Token inválido (401). Confira DISCORD_TOKEN no .env');
        if (!res.ok) return null; // sem permissão no canal etc.
        return res.json();
    }
}

// Snowflake -> timestamp: dispensa ler mensagens só para saber a última atividade.
const snowflakeMs = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);
const diasDesde = (ms) => Math.floor((Date.now() - ms) / 86_400_000);

async function coletar() {
    const guilds = await discord('/users/@me/guilds?with_counts=true');
    const out = [];
    for (const [i, g] of guilds.entries()) {
        console.error(`[${i + 1}/${guilds.length}] ${g.name}`);
        const canais = (await discord(`/guilds/${g.id}/channels`)) ?? [];
        const cats = Object.fromEntries(canais.filter((c) => c.type === 4).map((c) => [c.id, c.name]));
        const texto = canais
            .filter((c) => TEXT_TYPES.has(c.type))
            .sort((a, b) => (BigInt(b.last_message_id ?? 0) > BigInt(a.last_message_id ?? 0) ? 1 : -1));

        const ultimas = texto.filter((c) => c.last_message_id).map((c) => snowflakeMs(c.last_message_id));
        const semana = Date.now() - 7 * 86_400_000;

        // Amostra de mensagens: só 1 tentativa por servidor (403 em sequência também chama atenção).
        let amostra = [];
        for (const c of texto.slice(0, 1)) {
            const msgs = await discord(`/channels/${c.id}/messages?limit=20`);
            if (msgs?.length) {
                amostra = msgs.filter((m) => m.content).map((m) => `#${c.name}: ${m.content.slice(0, 200)}`);
                break;
            }
        }

        out.push({
            id: g.id,
            nome: g.name,
            membros: g.approximate_member_count,
            online: g.approximate_presence_count,
            dias_sem_mensagem: ultimas.length ? diasDesde(Math.max(...ultimas)) : null,
            canais_ativos_7d: ultimas.filter((t) => t > semana).length,
            canais: texto.slice(0, 40).map((c) => ({
                nome: c.name,
                categoria: cats[c.parent_id],
                topico: c.topic?.slice(0, 150) || undefined,
            })),
            amostra,
        });
    }
    return out;
}

const Plano = z.object({
    pastas: z.array(z.object({ nome: z.string(), descricao: z.string() })),
    servidores: z.array(
        z.object({
            id: z.string(),
            pasta: z.string(),
            o_que_e: z.string(),
            movimento: z.enum(['muito ativo', 'ativo', 'morno', 'parado']),
        })
    ),
});

async function classificar(dados) {
    const client = new Anthropic();
    const res = await client.messages.stream({
        model: 'claude-opus-5',
        max_tokens: 64000,
        output_config: { format: zodOutputFormat(Plano) },
        messages: [
            {
                role: 'user',
                content: `Estes são os servidores do Discord de uma pessoa, com canais, tópicos, amostra de mensagens recentes e métricas de atividade.

Para cada servidor: descreva em 1 frase o que ele é / para que serve (o_que_e), e classifique o movimento a partir de dias_sem_mensagem, canais_ativos_7d e online.
Depois agrupe os servidores em pastas por tópico (ex.: Programação, Games, Trabalho, Cripto, Comunidades BR...). Entre 4 e 12 pastas, nomes curtos (máx. 20 caracteres), em PT-BR. Servidores parados continuam na pasta do assunto deles (o campo movimento já mostra que estão parados). Todo servidor deve estar em exatamente uma pasta.

${JSON.stringify(dados)}`,
            },
        ],
    }).finalMessage();
    if (res.stop_reason !== 'end_turn' || !res.parsed_output) {
        throw new Error(`Classificação falhou (stop_reason=${res.stop_reason})`);
    }
    return res.parsed_output;
}

function relatorio(plano, dados) {
    const porId = Object.fromEntries(dados.map((d) => [d.id, d]));
    let md = `# Seus servidores do Discord\n\n`;
    for (const p of plano.pastas) {
        const srv = plano.servidores.filter((s) => s.pasta === p.nome);
        md += `## ${p.nome} (${srv.length})\n_${p.descricao}_\n\n| Servidor | O que é | Movimento | Membros | Dias sem msg |\n|---|---|---|---|---|\n`;
        for (const s of srv) {
            const d = porId[s.id] ?? {};
            md += `| ${d.nome} | ${s.o_que_e} | ${s.movimento} | ${d.membros ?? '?'} | ${d.dias_sem_mensagem ?? '—'} |\n`;
        }
        md += '\n';
    }
    return md;
}

// Monta o guild_folders do Discord: cada servidor em exatamente uma pasta; os que o plano esqueceu ficam soltos.
export function montarFolders(plano, guildIds) {
    const COLORS = [0x5865f2, 0x57f287, 0xfee75c, 0xeb459e, 0xed4245, 0xf47b67, 0x3498db, 0x9b59b6, 0x1abc9c, 0x95a5a6];
    const validos = new Set(guildIds);
    const usados = new Set();
    const folders = plano.pastas.map((p, i) => {
        const ids = plano.servidores
            .filter((s) => s.pasta === p.nome && validos.has(s.id) && !usados.has(s.id))
            .map((s) => (usados.add(s.id), s.id));
        return { id: Math.floor(Math.random() * 2 ** 31), name: p.nome.slice(0, 32), color: COLORS[i % COLORS.length], guild_ids: ids };
    }).filter((f) => f.guild_ids.length);
    const soltos = guildIds.filter((id) => !usados.has(id)).map((id) => ({ id: null, guild_ids: [id] }));
    return [...folders, ...soltos];
}

const cmd = process.argv[2];

if (cmd === 'scan') {
    if (!process.env.DISCORD_TOKEN) throw new Error('Defina DISCORD_TOKEN no .env');
    // Coleta é lenta (~1 req/s); reaproveita dados.json se já existir. Apague para recoletar.
    const dados = fs.existsSync('dados.json') ? JSON.parse(fs.readFileSync('dados.json', 'utf8')) : await coletar();
    fs.writeFileSync('dados.json', JSON.stringify(dados, null, 2));
    if (!process.env.ANTHROPIC_API_KEY) {
        console.error('dados.json salvo. Sem ANTHROPIC_API_KEY: classifique o dados.json por conta própria (ex.: no Claude Code) gerando plano.json, e rode "report".');
        process.exit(0);
    }
    console.error(`Classificando ${dados.length} servidores com Claude...`);
    const plano = await classificar(dados);
    fs.writeFileSync('plano.json', JSON.stringify(plano, null, 2));
    fs.writeFileSync('relatorio.md', relatorio(plano, dados));
    console.error('Pronto: relatorio.md e plano.json. Edite o plano.json se quiser e rode "apply".');
} else if (cmd === 'report') {
    // Regera o relatorio.md a partir do plano.json (útil depois de editar o plano à mão).
    const ler = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync('relatorio.md', relatorio(ler('plano.json'), ler('dados.json')));
    console.error('relatorio.md atualizado.');
} else if (cmd === 'apply') {
    if (!process.env.DISCORD_TOKEN) throw new Error('Defina DISCORD_TOKEN no .env');
    const plano = JSON.parse(fs.readFileSync('plano.json', 'utf8'));
    const atual = await discord('/users/@me/settings');
    if (!atual?.guild_folders) throw new Error('Não consegui ler as pastas atuais — abortando sem mexer em nada.');
    const backup = `backup-pastas-${Date.now()}.json`;
    fs.writeFileSync(backup, JSON.stringify(atual.guild_folders, null, 2));
    // guild_folders omite servidores que nunca foram arrastados (aparecem soltos no topo); soma os do dados.json.
    const coletados = fs.existsSync('dados.json') ? JSON.parse(fs.readFileSync('dados.json', 'utf8')).map((d) => d.id) : [];
    const guildIds = [...new Set([...atual.guild_folders.flatMap((f) => f.guild_ids), ...coletados])];
    const res = await discord('/users/@me/settings', {
        method: 'PATCH',
        body: JSON.stringify({ guild_folders: montarFolders(plano, guildIds) }),
    });
    if (!res) throw new Error(`O Discord recusou a alteração. Nada mudou; backup em ${backup}`);
    console.error(`Pastas aplicadas. Backup das antigas em ${backup} (restaure com: node --env-file=.env organizar.mjs restore ${backup})`);
} else if (cmd === 'notify' || cmd === 'notify-reset') {
    // notify: silencia todos e só notifica menção direta. notify-reset: volta ao padrão de cada servidor.
    const cfg = cmd === 'notify'
        ? { muted: true, message_notifications: 1, suppress_everyone: true, suppress_roles: true }
        : { muted: false, message_notifications: 3, suppress_everyone: false, suppress_roles: false };
    const ids = JSON.parse(fs.readFileSync('dados.json', 'utf8')).map((d) => d.id);
    // Uma requisição em lote (o que o próprio app usa) em vez de uma por servidor: menos pegada.
    const lote = await discord('/users/@me/guilds/settings', {
        method: 'PATCH',
        body: JSON.stringify({ guilds: Object.fromEntries(ids.map((id) => [id, cfg])) }),
    });
    if (lote) {
        console.error(`Aplicado em lote para ${ids.length} servidores.`);
    } else {
        console.error('Lote recusado; indo um por um, devagar.');
        for (const [i, id] of ids.entries()) {
            const ok = await discord(`/users/@me/guilds/${id}/settings`, { method: 'PATCH', body: JSON.stringify(cfg) });
            console.error(`[${i + 1}/${ids.length}] ${ok ? 'ok' : 'falhou'}`);
            if (i % 20 === 19) await sleep(20_000 + Math.random() * 40_000); // pausa longa a cada 20
        }
    }
} else if (cmd === 'restore') {
    const guild_folders = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const res = await discord('/users/@me/settings', { method: 'PATCH', body: JSON.stringify({ guild_folders }) });
    console.error(res ? 'Pastas restauradas.' : 'Falhou ao restaurar.');
} else if (cmd === 'test') {
    const plano = {
        pastas: [{ nome: 'Games' }, { nome: 'Dev' }, { nome: 'Vazia' }],
        servidores: [
            { id: '1', pasta: 'Games' },
            { id: '2', pasta: 'Dev' },
            { id: '1', pasta: 'Dev' }, // duplicado: fica só na primeira
            { id: '99', pasta: 'Dev' }, // não existe na conta: ignorado
        ],
    };
    const f = montarFolders(plano, ['1', '2', '3']);
    assert.deepStrictEqual(f.map((x) => x.guild_ids), [['1'], ['2'], ['3']]);
    assert.strictEqual(f[2].id, null); // '3' ficou solto
    assert.strictEqual(f.length, 3); // pasta vazia removida
    console.log('ok');
} else {
    console.error('uso: node --env-file=.env organizar.mjs scan | report | apply | notify | notify-reset | restore <backup.json> | test');
}
