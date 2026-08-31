# Merge automatizado Kia UVO com Codex

O marcador exato `CODEX_UNATTENDED_KIA_UVO_MERGE` identifica uma execução
não interativa, explicitamente autorizada, do worker
`scripts/kia-uvo-codex-merge.mjs`. Execute o merge sem pedir confirmação,
respeitando integralmente o prompt versionado e os limites abaixo.

- Trabalhe somente no clone temporário criado pelo worker.
- Preserve as personalizações locais e incorpore a versão upstream solicitada.
- Altere apenas `homeassistant/custom_components/kia_uvo/**` e
  `scripts/kia-uvo-upstream.json`.
- Não acesse segredos, Docker, Home Assistant ou arquivos privados.
- Não instale a integração, não reinicie serviços e não altere o checkout
  ativo.
- Não faça commit nem push. O worker valida, cria o commit e pode publicar
  somente uma branch candidata única sob `codex/kia-uvo-*`; `main` nunca é
  destino direto do worker Codex.
- Depois do sucesso do worker, `scripts/promote-kia-uvo-candidate.mjs` deve
  revalidar a candidata no host, exigir checkout limpo, aplicar com backup e
  rollback, confirmar o runtime e somente então commitar e enviar `main`.
- Se o merge seguro não puder ser comprovado, pare com falha e deixe a versão
  instalada intacta.
