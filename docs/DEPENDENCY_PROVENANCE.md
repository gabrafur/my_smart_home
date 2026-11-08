# Proveniência de dependências

[Português (principal)](DEPENDENCY_PROVENANCE.md) · [English](DEPENDENCY_PROVENANCE.en.md)

Este inventário separa código vendorizado, código próprio e dependências
instaladas por gerenciadores. A auditoria compara apenas arquivos rastreados
pelo Git; caches e runtime ignorados não fazem parte da distribuição pública.

## Integrações vendorizadas

| Nome | Projeto e origem | Versão imobilizada | Licença | Modificações locais | Atualização e atribuição | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| Alexa Media Player | [`alandtse/alexa_media_player`](https://github.com/alandtse/alexa_media_player) | origem exata em `scripts/alexa-media-upstream.json` | Apache-2.0 | `__init__.py` contém um guard local permitido; o aplicador exige o marcador ou prova que o alvo o absorveu | resolver tag/commit/objeto de tag, comparar byte a byte, aceitar apenas deltas permitidos, validar manifest/compilação, manter `LICENSE.upstream` e preservar notices Apache | pin local; atualização protegida |
| Kia Uvo / Hyundai Bluelink | [`Hyundai-Kia-Connect/kia_uvo`](https://github.com/Hyundai-Kia-Connect/kia_uvo) | origem exata em `scripts/kia-uvo-upstream.json` | MIT | proteção de rate limit, refresh tolerante a falha, histórico/eficiência de viagens, status de comandos e entidades relacionadas | reconciliar por staging/Codex, preservar copyright/licença MIT e promover somente após testes, backup, rollback e validação do runtime | pin local, modificado substancialmente |

O estado Amazon Kids é compartilhado entre plataformas. Um novo início de
plataforma inicializa apenas dispositivos ainda desconhecidos e revalida essa
seleção sob o lock, sem criar outro timer ou consultar novamente estados já
conhecidos. A regressão verifica chamadas da API simulada através da função real;
contar chamadas de um mock que substitui o filtro inteiro não prova esse contrato.

Os caminhos cobertos são, respectivamente,
`homeassistant/custom_components/<domínio>/**`. Cada diretório contém uma cópia
verificada da licença upstream em `LICENSE.upstream`; hashes e método de
revalidação estão abaixo.

## HACS retirado após migração para Marketplace

No Core `2026.11.0`, o Marketplace nativo substituiu a cópia vendorizada de
HACS. O código instalado de `components/marketplace/migration.py` contém
`_remove_legacy_integration`, que remove a integração customizada após conferir
o domínio legado e excluir checkouts de desenvolvimento próprios. A remoção
observada de HACS é reconciliada aqui; não
resta código HACS vendorizado nem manifesto local a atualizar ou restaurar.
Marketplace é fornecido pela imagem do Core fixada no Compose, não por uma nova
cópia de código neste repositório. A imagem auditada foi
`sha256:c6c1ca9931036bf3a2c4cc088d8db25dfea3b33935a5ecc83c40349462e2f69e`;
o SHA-256 do módulo de migração instalado era
`e1c5775e2483f8cf0610049122fd9fa109ca174b3f6709926aafe2bc3e657c4e`.

Proveniência histórica preservada: `hacs/integration`, tag leve `2.0.5`, commit
`c0dfd8b44297c3673c21973e2539375a53687a9c` (sem objeto de tag anotada).
A árvore Git retirada, `4e47869f7ca4f0a12c80c3cf13207274accfaa8e`, foi
recomparada byte a byte com esse commit: 62 arquivos de código idênticos,
licença MIT idêntica e somente dois deltas locais, `const.py` (HA mínimo
`2024.4.1`) e `manifest.json` (versão `2.0.5`). Esses deltas não são transferidos
para o Marketplace nativo. A licença e seu copyright permanecem no histórico,
por exemplo em `1a8d7f53f368c533116f1af06a47c9e74a070f51:homeassistant/custom_components/hacs/LICENSE.upstream`;
o hash histórico está abaixo. Ao redistribuir uma revisão antiga com HACS,
preserve sua licença MIT. Esta auditoria de arquivos não prova sozinha a
migração dos registros de entidades, a saúde do runtime ou a preservação do
Recorder; essas verificações operacionais são separadas.

## Componentes próprios e serviços externos

`icloud` é uma adaptação local que delega as plataformas ao Home Assistant Core
instalado e restringe o envio de OTP à ação manual. Seu código Python é próprio;
os recursos de interface derivados do Core preservam Apache-2.0 em
`homeassistant/custom_components/icloud/LICENSE.upstream`. `upstream.json` no
mesmo diretório registra tag, commit, digest da imagem e hashes dos recursos
originais. Os deltas nos recursos são o texto da etapa de verificação e exemplos de conta
substituídos pelo domínio reservado `example.invalid`.
Compatibilidade e testes: [reautenticação manual](ICLOUD_MANUAL_AUTH.md).

`claude_code_chat` e `public_bindings` são implementações deste
repositório, não cópias dos projetos citados em seus manifests. Links para
Anthropic e a documentação do próprio repositório identificam APIs ou
serviços integrados; não transferem licença sobre o código local.

Esses componentes próprios seguem a [licença GPL-3.0-only](../LICENSE) do
trabalho original, sem substituir os termos de dependências externas.

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
hacs (histórico)  62 iguais,  2 modificados
kia_uvo           24 iguais, 10 modificados
```

Hashes SHA-256 das licenças preservadas (HACS somente no histórico):

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

O trabalho original segue [GPL-3.0-only](../LICENSE). Licenças e copyright
upstream continuam válidos para os arquivos vendorizados. Este documento é
evidência técnica de proveniência, não uma declaração de titularidade sobre
código de terceiros.
