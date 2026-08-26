# Proveniência de dependências

[Português (principal)](DEPENDENCY_PROVENANCE.md) · [English](DEPENDENCY_PROVENANCE.en.md)

Este inventário separa código vendorizado, código próprio e dependências
instaladas por gerenciadores. A auditoria compara apenas arquivos rastreados
pelo Git; caches e runtime ignorados não fazem parte da distribuição pública.

## Integrações vendorizadas

| Nome | Projeto e origem | Versão imobilizada | Licença | Modificações locais | Atualização e atribuição | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| Alexa Media Player | [`alandtse/alexa_media_player`](https://github.com/alandtse/alexa_media_player) | tag `v5.15.7`, commit `5365f875c00692771f17c957a58553f30682b5c3` (objeto de tag anotada `eef9f9c95645c485b4028cd2dc7154f9493093de`) | Apache-2.0 | nenhuma nos 39 arquivos rastreados comparados | substituir pelo diretório da release, conferir manifest e manter `LICENSE.upstream`; preservar licença e notices exigidos pela Apache-2.0 | verificado |
| HACS | [`hacs/integration`](https://github.com/hacs/integration) | tag `2.0.5`, commit `c0dfd8b44297c3673c21973e2539375a53687a9c` | MIT | `const.py` fixa HA mínimo `2024.4.1`; `manifest.json` registra `2.0.5` | reaplicar e revisar somente esses dois deltas após atualização; manter copyright e licença MIT | verificado, modificado |
| Kia Uvo / Hyundai Bluelink | [`Hyundai-Kia-Connect/kia_uvo`](https://github.com/Hyundai-Kia-Connect/kia_uvo) | tag `v3.10.1`, commit `2c602560746318fd001db8fe52347e9398f181ed` | MIT | 10 de 34 arquivos alterados: proteção de rate limit, refresh tolerante a falha, histórico/eficiência de viagens, status de comandos e entidades relacionadas | atualização é análise manual; comparar com a tag, portar deltas, executar testes e preservar copyright/licença MIT | verificado, modificado substancialmente |
| LocalTuya | [`rospogrigio/localtuya`](https://github.com/rospogrigio/localtuya) | tag `v5.2.3`, commit `5f2c027c1e9421a93dcc937bf151b9456add04c6` | GPL-3.0-only | 3 de 24 arquivos alterados: registro de serviço, setup de plataformas/options flow e API `VacuumActivity` | atualização é comparação manual; o código e as modificações deste diretório permanecem sob GPL-3.0-only e a licença deve acompanhar a distribuição | verificado, modificado |
| Tuya Vacuum Maps | [`jaidenlabelle/tuya-vacuum-maps`](https://github.com/jaidenlabelle/tuya-vacuum-maps) | tag `v0.1.4`, commit `796da700777fa084fe844ed70c882303a09fc268` | MIT | nenhuma nos 5 arquivos rastreados comparados | substituir pela release, conferir manifest e manter copyright/licença MIT | verificado |

Os caminhos cobertos são, respectivamente,
`homeassistant/custom_components/<domínio>/**`. Cada diretório contém uma cópia
verificada da licença upstream em `LICENSE.upstream`; hashes e método de
revalidação estão abaixo.

## Componentes próprios e serviços externos

`claude_code_chat` e `public_bindings` são implementações deste
repositório, não cópias dos projetos citados em seus manifests. Links para
Anthropic e a documentação do próprio repositório identificam APIs ou
serviços integrados; não transferem licença sobre o código local.

Nenhum desses componentes próprios possui hoje declaração de licença. Eles
seguem o bloqueio da [licença raiz](../THIRD_PARTY_NOTICES.md#repository-level-license-status).

`moni_mobile` foi extraído para
[`gabrafur/moni_mobile_home_assistant`](https://github.com/gabrafur/moni_mobile_home_assistant),
licenciado sob MIT e instalado pelo HACS. O diretório de runtime
`/config/custom_components/moni_mobile/` não é mais rastreado neste repositório;
a release HACS é a única fonte canônica do código da integração.

## Dependências gerenciadas

- `nodered/package-lock.json` fixa o grafo npm do Node-RED, inclusive
  `node-red-contrib-home-assistant-websocket` e `node-red-contrib-dulonode`.
  Para o Dulonode 1.0.11, `nodered/tools/patch-dulonode-retry.mjs` aplica no
  startup um patch local, minimo e idempotente que repete o deploy inicial
  depois de falhas transitorias de DNS. O pacote instalado conserva sua
  licenca e proveniencia upstream; o patch nao substitui os arquivos de
  licenca do pacote.
- `validation/package-lock.json` fixa `yaml@2.9.0`, usado apenas pela validação.
- `local-ai-integration/local-ai-rtx.lock.json` fixa repositório, release,
  commit e SHA-256 do runtime externo; o instalador rejeita divergência antes
  de ativar uma release imutável.
- Os `requirements` dos manifests do Home Assistant são resolvidos pela
  instalação da integração; eles não são código-fonte vendorizado aqui.
- As imagens do Compose são fixadas por digest. Origem, versão e política de
  atualização ficam em [Containers](CONTAINERS.md).

Locks e digests garantem resolução reproduzível, mas não substituem as licenças
de cada pacote ou imagem. Quem redistribui bundles deve preservar também os
notices fornecidos pelos respectivos artefatos.

## Método de verificação

As tags oficiais foram baixadas, seus commits resolvidos com `git ls-remote` e
cada arquivo rastreado foi comparado byte a byte com
`custom_components/<domínio>` da tag. A verificação desta revisão resultou em:

```text
alexa_media       39 iguais,  0 modificados
hacs              62 iguais,  2 modificados
kia_uvo           24 iguais, 10 modificados
localtuya         21 iguais,  3 modificados
tuya_vacuum_maps   5 iguais,  0 modificados
```

Hashes SHA-256 das licenças preservadas:

```text
alexa_media       c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4
hacs              75eb6a4da2ae957a05b187d677f71b72d00a6ffd0f94f7859fb4740b4023e0d8
kia_uvo           5ba515e35c827b547f02f7adf15b6cc707496abd7c9f8d1bdcc4676c43076662
localtuya         3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986
tuya_vacuum_maps  6234c4decf5931fe8b0ab35a4d75bd279353083e329f82d4fd827c32f8eaff0c
```

Ao atualizar um componente, repita a comparação, atualize tag/commit,
modificações e hash, e rode `make validate-public`.

## Limite jurídico

Não existe `LICENSE` na raiz por decisão intencional: o proprietário ainda
precisa escolher a licença do trabalho original e avaliar a distribuição
mista. A licença GPL do LocalTuya continua válida no diretório coberto, mas não
autoriza presumir uma licença para arquivos independentes. Este documento é
evidência técnica de proveniência, não aconselhamento jurídico.
