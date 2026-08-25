# Canário de extração estruturada residual

Esta pasta registra somente evidência sanitizada e agregada da ativação
operacional controlada de 2026-08-25. O canário cobre exclusivamente residuais
de `structured_extraction`, usa `qwen2.5-coder:14b`, coorte estável de 10%,
validação fail-closed e fallback GPT direto.

Os defaults do repositório continuam desabilitados e com rollout 0. A ativação
de 10% pertence ao runtime privado e não está versionada. Probes, benchmarks e
tráfego de produção são contabilizados separadamente; as 21 sondas deste pacote
não alteram a amostra operacional.

Arquivos:

- [`readiness.json`](readiness.json): checks de prontidão e limites da decisão;
- [`canary-config.json`](canary-config.json): configuração pública, override declarado e valor
  efetivo, sem revelar o arquivo privado;
- [`smoke-results.json`](smoke-results.json): resultados das sondas e prova agregada da RTX;
- [`latest-operational-summary.json`](latest-operational-summary.json): snapshot sanitizado produzido pelo audit;
- [`report.md`](report.md): relatório humano produzido pelo mesmo audit.

Eventos detalhados permanecem em storage local ignorado pelo Git. Inputs,
outputs, paths privados, identificadores reversíveis, credenciais e conteúdo
extraído são proibidos nestes artefatos.

Para renovar o snapshot operacional sem executar inferência:

```bash
make local-ai-structured-extraction-canary-audit
```

O estado inicial é `CANARY_ACTIVE_INSUFFICIENT_OPERATIONAL_SAMPLE`. Nenhum gate
de progressão pode ser aprovado antes de 100 tentativas reais auditadas; até
lá, a decisão é `KEEP_AT_10_PERCENT`.
