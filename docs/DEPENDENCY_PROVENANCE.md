# Proveniência de dependências

[Português (principal)](DEPENDENCY_PROVENANCE.md) · [English](DEPENDENCY_PROVENANCE.en.md)

Este inventário separa código vendorizado, código próprio e dependências
instaladas por gerenciadores. A auditoria compara apenas arquivos rastreados
pelo Git; caches e runtime ignorados não fazem parte da distribuição pública.

## Integrações vendorizadas

| Nome | Projeto e origem | Versão imobilizada | Licença | Modificações locais | Atualização e atribuição | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| Alexa Media Player | [`alandtse/alexa_media_player`](https://github.com/alandtse/alexa_media_player) | origem exata em `scripts/alexa-media-upstream.json` (`v5.16.0` nesta revisão) | Apache-2.0 | `__init__.py` contém um guard local permitido; o aplicador exige o marcador ou prova que o alvo o absorveu | resolver tag/commit/objeto de tag, comparar byte a byte, aceitar apenas deltas permitidos, validar manifest/compilação, manter `LICENSE.upstream` e preservar notices Apache | verificado, atualização protegida |
| HACS | [`hacs/integration`](https://github.com/hacs/integration) | tag `2.0.5`, commit `c0dfd8b44297c3673c21973e2539375a53687a9c` | MIT | `const.py` fixa HA mínimo `2024.4.1`; `manifest.json` registra `2.0.5` | reaplicar e revisar somente esses dois deltas após atualização; manter copyright e licença MIT | verificado, modificado |
| Kia Uvo / Hyundai Bluelink | [`Hyundai-Kia-Connect/kia_uvo`](https://github.com/Hyundai-Kia-Connect/kia_uvo) | origem exata em `scripts/kia-uvo-upstream.json` (`v3.12.0`, commit `97f5d61b92209a0476762f625f5053e414063eba` nesta revisão) | MIT | proteção de rate limit, refresh tolerante a falha, histórico/eficiência de viagens, status de comandos e entidades relacionadas | reconciliar por staging/Codex, preservar copyright/licença MIT e promover somente após testes, backup, rollback e validação do runtime | verificado, modificado substancialmente |

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
alexa_media       38 iguais,  1 modificado
hacs              62 iguais,  2 modificados
kia_uvo           24 iguais, 10 modificados
```

Hashes SHA-256 das licenças preservadas:

```text
alexa_media       c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4
hacs              75eb6a4da2ae957a05b187d677f71b72d00a6ffd0f94f7859fb4740b4023e0d8
kia_uvo           5ba515e35c827b547f02f7adf15b6cc707496abd7c9f8d1bdcc4676c43076662
```

Ao atualizar um componente, repita a comparação e atualize tag/commit,
modificações e hash. Para Alexa e Kia, os JSONs de upstream são a fonte
executável da origem exata e são atualizados apenas depois de uma promoção
validada. Por fim, rode `make validate-public`.

## Limite jurídico

Não existe `LICENSE` na raiz por decisão intencional: o proprietário ainda
precisa escolher a licença do trabalho original e avaliar a distribuição
mista. As licenças dos componentes vendorizados continuam válidas somente nos
respectivos diretórios cobertos e não autorizam presumir uma licença para
arquivos independentes. Este documento é evidência técnica de proveniência,
não aconselhamento jurídico.
