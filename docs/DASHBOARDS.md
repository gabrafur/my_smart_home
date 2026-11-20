# Painéis do Home Assistant

Os painéis são divididos por público e frequência de uso, não por tecnologia.
Todos ficam em YAML em `homeassistant/dashboards/` e são registrados em
`lovelace.dashboards` de `homeassistant/configuration.yaml`.

| Painel | Rota | Quem vê | Abas | Arquivo |
| --- | --- | --- | --- | --- |
| Casa | `/painel-casa` (padrão do sistema) | Todos | Início, Ambientes, Segurança, Rotina | `casa.yaml` |
| Home | `/casa-en` | Só administradores | Home, Rooms, Security, Routine | `en/casa.yaml` (gerado) |
| Creta | `/creta-viagens` | Todos | Visão geral, Detalhes | `vehicle_primary.yaml` |
| Creta (inglês) | `/creta-en` | Só administradores | Overview, Details | `en/vehicle_primary.yaml` (gerado) |
| Mapa | `/map` (nativo) | Todos | Mapa | `location.yaml`, aplicado por `consolidated_map` |
| Chat | `/chat-assistants` | Todos | Codex | `chat.yaml` |
| System | `/painel-sistema` | Só administradores (`require_admin`) | Health, Server, Codex, RTX 4070 | `en/sistema.yaml` (gerado de `sistema.yaml`) |

O painel Casa é o padrão do sistema (dado de sistema `frontend` ›
`core.default_panel = painel-casa`). A conta do administrador usa o perfil em
inglês, com padrão pessoal `casa-en` e os painéis em português ocultos na sua
barra lateral; os moradores usam o perfil em português e não veem as cópias em
inglês. Energia, Calendário, Listas, Histórico e Atividade continuam nativos.

## Idiomas

Textos nativos do Home Assistant (estados, menus, diálogos) seguem o idioma do
perfil de cada pessoa. Os textos escritos nos painéis não mudam por usuário no
Lovelace, então cada painel tem uma fonte em português e uma cópia em inglês:

- **Fonte**: `homeassistant/dashboards/*.yaml`, em português. Toda mudança é
  feita aqui.
- **Catálogo**: `homeassistant/dashboards/i18n/en.json` — `exact` para títulos,
  nomes e confirmações; `keep` para o que é igual nos dois idiomas; `phrases`
  para trechos de Markdown/Jinja; `navigation` para apontar links às cópias.
- **Gerador**: `node scripts/dashboard-i18n.mjs` escreve
  `homeassistant/dashboards/en/*.yaml`. `--check` (parte de
  `make validate-homeassistant`) falha se a cópia estiver desatualizada, se
  sobrar texto em português ou se a tradução alterar entidades, ações,
  condições ou a lógica dos templates.
- O cartão de chat do Codex escolhe português ou inglês pelo idioma do perfil.
- Ficam como estão: textos produzidos por sensores e pelo Node-RED, nomes de
  entidades, o painel Mapa (inglês por decisão de projeto) e as frases que a
  Alexa fala.

## Regras de desenho

- **Tema `casa`** (`homeassistant/themes/casa.yaml`), modos claro e escuro,
  definido como tema padrão do servidor (`frontend.set_theme`). Azul é a cor
  da interface; latão marca o que está aceso; verde, âmbar e vermelho ficam
  reservados a estados.
- **Layout Sections** com grade nativa: tile de meia largura para comandos,
  largura cheia para clima, aspirador, alarme e listas.
- **Um título por seção** (cartão `heading`); os cartões abaixo não repetem
  título.
- **Nomes curtos no cartão**, sem renomear entidades: Alexa, Node-RED e
  automações continuam vendo os nomes originais.
- **Ação física confirma ou abre o diálogo nativo.** O portão confirma em todos
  os lugares; o alarme abre o teclado que exige código; a trava do Creta leva ao
  painel do carro, onde os comandos passam pelo coordenador; o relé do portão é
  só leitura. Reiniciar ou desligar o Raspberry e o PC fica no Sistema, com
  confirmação.
- **Pendências técnicas ficam no Sistema** (seção “Pede atenção”, só visível
  quando há algo errado). O painel Casa mostra estado da casa, não do servidor.
- **Papéis públicos**: pessoas aparecem pelos trackers de papel
  `device_tracker.resident_*_location`; aparelhos com nome pessoal entram por
  cartão de área, sem citar o `entity_id` no repositório.

## Falar na Alexa

A seção da aba Início tem o campo de texto, o botão **Falar agora** e frases
rápidas. Uma frase rápida só preenche o campo; quem fala é sempre o botão. O
botão (`button.ler_mensagem_na_alexa`, pacote `alexa_text_announcements.yaml`)
publica `alexa_text_announcement_requested` e depois limpa o campo, o que
confirma o envio e evita repetir a mensagem anterior. Destino e entrega
continuam no hub `hub_notificacoes_alexa` do Node-RED.

## Comedouro

Na aba Rotina, **Servir ração** abre o diálogo nativo da entidade
`number.paf_a07_feed`: escolher a quantidade serve a ração na hora, sem outra
confirmação. Os tiles ao lado mostram se está servindo e a última porção.

## Testes

`homeassistant/tests/test_casa_dashboard.py` garante que os controles da casa
continuam no painel Casa, que o portão sempre confirma, que alarme e trava não
agem por toque, que comandos do servidor só existem no Sistema e que o Sistema
exige administrador. Os testes de backup, formatação, RTX e Alexa leem
`sistema.yaml` e `casa.yaml`.

## Rollback

Cada mudança é um commit; `git revert` seguido de reinício do Home Assistant
restaura os painéis anteriores. O padrão do sistema volta ao Overview em
Configurações › Painéis, e o tema em Perfil › Tema ou com
`frontend.set_theme` (`name: default`).
