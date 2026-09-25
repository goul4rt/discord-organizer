# discord-organizer

Você está em 170 servidores do Discord, a barra lateral virou um paredão de ícones e você não lembra metade do que cada um é. Este script resolve isso:

1. **Lê seus servidores**: canais, tópicos, algumas mensagens recentes e quanto cada um anda movimentado.
2. **Pede para o Claude dizer o que cada servidor é** e agrupar tudo em pastas por assunto (Dev, Games, Anime, Minecraft...).
3. **Gera um relatório** para você revisar e ajustar antes de mudar qualquer coisa.
4. **Cria as pastas na sua barra lateral**, com backup da organização anterior.
5. Opcional: **silencia todos os servidores** e deixa passar só as menções diretas a você.

Um script, duas dependências, sem servidor e sem banco.

## ⚠️ Leia antes de usar

Este script usa o **token da sua conta de usuário**, e não o de um bot. Isso é o que se chama de *selfbot*, e **os Termos de Serviço do Discord proíbem**. Sua conta pode ser suspensa ou banida. Use por sua conta e risco.

Não dá para fazer isso com bot oficial: as pastas da barra lateral e as notificações são configurações da **sua conta**, e um bot não enxerga nem mexe nelas.

O script tenta deixar pouco rastro:

- intervalo aleatório de 1,5 a 4 s entre requisições, sem ritmo fixo;
- uma única tentativa de ler mensagens por servidor;
- se o Discord pedir para esperar (429), espera o dobro do tempo;
- a coleta roda uma vez e é reaproveitada (`dados.json`);
- a organização em pastas é gravada numa única requisição, e as notificações também;
- **nunca** envia mensagem, reage, entra ou sai de servidor.

Mesmo assim, o risco não é zero. Não rode em loop nem em horário agendado.

**Privacidade:** para classificar os servidores, os nomes dos canais e trechos de mensagens recentes são enviados para a API da Anthropic. Se não quiser isso, veja [Sem chave da Anthropic](#sem-chave-da-anthropic).

## Requisitos

- Node.js 20.6 ou mais novo (por causa do `--env-file`)
- Seu token do Discord
- Uma API key da Anthropic ([console.anthropic.com](https://console.anthropic.com)). Opcional, veja abaixo.

## Instalação

```bash
git clone https://github.com/goul4rt/discord-organizer
cd discord-organizer
npm install
cp .env.example .env
```

Preencha o `.env`, uma variável por linha:

```env
DISCORD_TOKEN=seu_token_aqui
ANTHROPIC_API_KEY=sk-ant-api03-...
```

### Como pegar o token do Discord

1. Abra o Discord **no navegador** (discord.com/app) e faça login.
2. Abra o DevTools (F12) e vá na aba **Network** (Rede).
3. Clique em qualquer canal para gerar tráfego e filtre por `api`.
4. Clique numa requisição e, em **Request Headers**, copie o valor de `authorization`.

> O token dá acesso total à sua conta. Não cole em lugar nenhum, não faça commit, não mande para ninguém. Se vazar, **troque a senha do Discord**: isso invalida o token na hora.

## Como usar

### 1. Coletar e classificar

```bash
npm run scan
```

Leva alguns minutos: são 2 requisições por servidor, com as pausas aleatórias. No fim, você terá:

- `dados.json`: o que foi coletado. Nas próximas execuções ele é reaproveitado. Apague o arquivo para coletar de novo.
- `plano.json`: em que pasta cada servidor vai.
- `relatorio.md`: uma tabela por pasta com o que cada servidor é, a movimentação, o número de membros e há quantos dias está sem mensagens.

Exemplo de relatório:

| Servidor | O que é | Movimento | Membros | Dias sem msg |
|---|---|---|---|---|
| Discord Developers | Oficial: API, bots, Activities, Social SDK | muito ativo | 304690 | 0 |
| Hytale Brasil | Maior comunidade BR de Hytale | ativo | 4718 | 0 |
| Survale | Servidor de Hytale que não vingou | parado | 41 | 182 |

### 2. Revisar

Abra o `relatorio.md`. Para mudar um servidor de pasta, edite o campo `pasta` dele no `plano.json`. Para criar ou renomear pastas, mexa na lista `pastas`. Depois gere o relatório de novo para conferir:

```bash
npm run report
```

### 3. Aplicar as pastas

```bash
npm run apply
```

Antes de mudar qualquer coisa, o script salva a organização atual em `backup-pastas-<timestamp>.json`. Servidores que não estão no plano ficam soltos, fora das pastas.

### 4. (Opcional) Só menções diretas

```bash
npm run notify
```

Em todos os servidores, isso configura:

- **Silenciar o servidor:** some a bolinha de "não lido".
- **Notificar:** só menções.
- **Ignorar @everyone e @here.**
- **Ignorar menções de cargo.**

Resultado: você só é notificado quando alguém marca **você**. O contador vermelho de menção continua aparecendo em servidores silenciados.

## Desfazer

```bash
# volta as pastas para como estavam antes do apply
node --env-file=.env organizar.mjs restore backup-pastas-<timestamp>.json

# volta as notificações para o padrão de cada servidor
npm run notify-reset
```

Não existe backup das configurações de notificação anteriores. O `notify-reset` volta tudo para o padrão de cada servidor.

## Sem chave da Anthropic

Sem `ANTHROPIC_API_KEY`, o `scan` só coleta os dados, salva o `dados.json` e para. A partir daí você pode:

- pedir para o [Claude Code](https://claude.com/claude-code) (ou outra IA) ler o `dados.json` e gerar o `plano.json` no formato abaixo;
- ou montar o `plano.json` à mão.

Depois disso, rode `npm run report` e `npm run apply` normalmente.

```json
{
  "pastas": [{ "nome": "Dev & Bots", "descricao": "Bots, programação e IA" }],
  "servidores": [
    { "id": "613425648685547541", "pasta": "Dev & Bots", "o_que_e": "Oficial Discord Developers", "movimento": "muito ativo" }
  ]
}
```

`movimento` aceita os valores `muito ativo`, `ativo`, `morno` ou `parado`.

## Comandos

| Comando | O que faz | Fala com o Discord? |
|---|---|---|
| `npm run scan` | coleta os dados e classifica | sim (leitura) |
| `npm run report` | gera o `relatorio.md` a partir do `plano.json` | não |
| `npm run apply` | cria as pastas, com backup | 2 requisições |
| `npm run notify` | só menções diretas em todos os servidores | 1 requisição |
| `npm run notify-reset` | volta as notificações ao padrão | 1 requisição |
| `node --env-file=.env organizar.mjs restore <arquivo>` | restaura as pastas de um backup | 1 requisição |
| `npm test` | teste da montagem das pastas | não |

## Limitações

- As pastas usam o endpoint antigo `PATCH /users/@me/settings`. Ele funciona hoje, mas o Discord pode desativá-lo sem aviso.
- Nomes de pasta com mais de 32 caracteres são cortados.
- As cores das pastas seguem uma paleta fixa e não dá para escolher pelo `plano.json`.

## Licença

MIT. Projeto sem nenhuma ligação com o Discord ou a Anthropic.
