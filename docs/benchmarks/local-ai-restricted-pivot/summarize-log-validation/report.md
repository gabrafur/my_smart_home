# Validação factual de `summarize-log`

Decisão: `DETERMINISTIC_ONLY`. O resumo local preservou 100.00% dos fatos críticos e obteve redução incremental de -49.87% contra o extrator determinístico.

Resultados rejeitados usam a saída determinística e contabilizam zero tokens evitados. O benchmark não altera a telemetria operacional.

Limitações: logs sanitizados/sintéticos, tokens de contexto estimados e GPT direto não executado.
