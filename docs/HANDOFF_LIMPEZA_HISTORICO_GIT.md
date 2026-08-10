# Handoff: fechamento da limpeza e do fluxo de chegada

Atualizado em 2026-08-08. Este documento substitui o handoff de 2026-08-07;
os itens obsoletos (181 delecoes staged e `.ha_ws.py`) foram removidos.

## Estado atual

- A arvore rastreada atual nao contem coordenadas nem segredos: o scanner e a
  bateria completa de configuracao passam.
- As coordenadas antigas ainda estao em commits alcancaveis do Git. A limpeza
  do historico esta pronta, mas o force-push exige autorizacao explicita.
- O refresh periodico Kia foi alinhado ao piso real de 15 min do backend BR.
  O tick de 30 s permanece somente para a cadencia adaptativa dos iPhones; a
  entrada na `zone.chegando` conserva o wake pontual do Creta.
- O fluxo foi validado por replay automatizado e carregado no Node-RED.
- Os dois iPhones ja produziram estado `chegando`, portanto a zona foi
  sincronizada. O tracker da Valeria saiu da posicao em que estava congelado,
  mas deve continuar sendo observado.
- Ainda nao houve um `on` real do refletor desde a implantacao. A comprovacao
  numa chegada noturna real continua sendo uma observacao de producao.

## Limpeza do historico Git

Ferramentas versionadas:

- `scripts/scrub-coordinates-history.sh`
- `scripts/scrub-coordinate-values.mjs`

O script nao contem coordenadas. Ele as descobre dentro do proprio historico,
guarda a lista apenas num diretorio temporario com permissao 0600 e:

1. adquire o mesmo lock usado pelo backup automatico das 03:30;
2. trabalha num clone isolado;
3. reescreve todas as refs locais com `git filter-branch`;
4. remove `refs/original`, reflogs e objetos inalcancaveis no clone;
5. confirma que nenhum literal continua alcancavel;
6. exige que a arvore do HEAD seja byte a byte identica a original;
7. no modo `--push`, cria bundle e tar protegidos, publica com
   `force-with-lease`, verifica um clone novo do GitHub e realinha o repo vivo
   com `git reset --soft`, preservando indice e working tree.

Dry-run executado com sucesso em 2026-08-08:

```text
5 literais historicos removidos
82 refs/commits inspecionados
arvore do HEAD preservada
```

Comandos:

```bash
cd CAMINHO_DO_REPOSITORIO
scripts/scrub-coordinates-history.sh
scripts/scrub-coordinates-history.sh --push
```

O segundo comando e destrutivo e requer a confirmacao explicita do usuario.
Depois de verificar o remoto, os backups protegidos ficam em
`.local-secrets/history-scrub-backups/`. Eles ainda contem o historico antigo e
devem ser apagados quando a recuperacao deixar de ser necessaria. Os 12
`nodered/flows.json.bak*` locais tambem contem copias antigas e devem ser
removidos na mesma janela autorizada.

O repositorio e publico. Zero forks nao prova ausencia de clones; trate as
coordenadas como informacao ja exposta. Um force-push remove as refs normais,
mas clones externos e caches do GitHub podem sobreviver. Depois do push, abrir
um pedido ao GitHub Support para avaliar refs/cache ainda acessiveis.

## Cadencia e testes do fluxo

Configuracao efetiva:

- iPhones: 1 min longe, 30 s perto; tick base de 30 s;
- Kia periodico: 15 min longe, perto ou em casa;
- baseline em casa: somente das 07h as 22h;
- aproximacao: wake pontual por `sec_approach_wake_gate`;
- coordinator BR: piso final de 15 min entre wakes reais.

Validacao reproduzivel:

```bash
cd CAMINHO_DO_REPOSITORIO/nodered
npm run flows:validate
npm run flows:test-security
```

O replay cobre oito cenarios: fallback sem env, pessoa sem Creta, motor velho
com trava de uso, chegada pela localizacao do Creta, desligado+destravado,
anti-religamento, tracker congelado com/sem Creta e saida de casa. Ele tambem
compila todos os function nodes.

O antigo `tools/install-security-light-flow.mjs` foi desativado porque gerava
uma versao obsoleta do fluxo. A fonte de verdade e `nodered/flows.json`.

## Observacao de producao que permanece

Na proxima chegada noturna de carro:

```bash
docker logs nodered --since 30m | grep -i refletor
```

Confirmar no recorder que `switch.refletor_portao_carros` ligou na entrada da
`zone.chegando`, aproximadamente 2–3 min antes da chegada, e apagou por uma das
cinco condicoes. Este item nao pode ser encerrado por simulacao; o replay apenas
garante a logica antes do evento real.
