# Merge automatizado do fork Kia UVO

<!-- CODEX_UNATTENDED_KIA_UVO_MERGE -->

Esta execução é não interativa e foi autorizada pelo proprietário do
repositório. Faça o merge solicitado imediatamente, sem pedir confirmação.

Você está em um clone temporário e descartável. O worker externo fará a
validação, o commit e, quando habilitado, o push de uma branch candidata.
Você não deve executar `git commit` nem `git push`.

## Objetivo

Incorpore a versão upstream informada no final deste prompt em
`homeassistant/custom_components/kia_uvo`, preservando todas as adaptações
locais necessárias ao funcionamento residencial. Use como base histórica
`scripts/kia-uvo-upstream.json` e compare o componente local com as tags
oficiais do repositório `Hyundai-Kia-Connect/kia_uvo`.

Resolva conflitos semanticamente. Não se limite a reaplicar mecanicamente um
patch que já falhou. Mantenha as correções locais e também as mudanças
funcionais do novo upstream quando forem compatíveis.

## Escopo obrigatório

Você pode alterar somente:

- `homeassistant/custom_components/kia_uvo/**`;
- `scripts/kia-uvo-upstream.json`.

Atualize `base_version` para a versão alvo e `base_commit` para o commit oficial
da tag usada. Não crie symlinks.

## Segurança

- Não leia `.local-secrets/`, `bindings/private/`, `.agent-history/` nem
  credenciais.
- Não use Docker, APIs do Home Assistant ou estado de runtime.
- Não execute `update.install`, não pare/reinicie serviços e não altere a
  instalação ativa.
- Não faça push para `main` ou para qualquer branch; o worker é o único
  responsável pela publicação da candidata.
- Se não for possível preservar com segurança os comportamentos locais, pare
  com erro e explique no log; não remova silenciosamente personalizações.

## Verificação mínima

Antes de terminar:

1. confirme a versão do `manifest.json`;
2. preserve os marcadores funcionais exigidos por
   `scripts/kia-uvo-safe-update.mjs`;
3. execute `python3 -m compileall -q homeassistant/custom_components/kia_uvo`;
4. revise `git diff --check` e `git status --short`;
5. confirme que todos os caminhos alterados estão no escopo permitido.

O worker repetirá essas verificações e rejeitará qualquer saída fora do
contrato.
