# Proteção obrigatória do host residencial

Este checkout atende a casa ativa. SSH, Home Assistant, Node-RED, MQTT e
as automações têm prioridade sobre auditorias, builds e testes.

- Subagentes são permitidos em frentes independentes, com arquivos e
  responsabilidades separados e coordenação pelo agente principal.
- Mantenha apenas uma validação pesada, instalação NPM, clean-room ou suíte
  ampla por vez. Subagentes não podem iniciá-las independentemente.
- Antes de validar amplamente ou delegar carga, confira `uptime`, `free -h` e
  `df -h /`; não inicie com menos de 2 GiB disponíveis, disco acima de 85% ou
  pressão elevada.
- Use o alvo canônico e `scripts/run-resource-safe.sh`, sem contornar a redução
  de prioridade de CPU e I/O.
- Checks direcionados primeiro; no máximo uma validação ampla por ciclo.
  Repetições e clean-room vão para CI ou máquina isolada com limites.
- Pare a carga do agente e reduza ou encerre subagentes se SSH, dashboard ou
  serviços degradarem. Nunca reinicie host ou stack para concluir trabalho.
- Não use `make -j` nem concorrência de testes neste host.

Persistência e validação completa não autorizam sacrificar a casa.
