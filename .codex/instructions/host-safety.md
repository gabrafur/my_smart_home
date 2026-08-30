# Proteção obrigatória do host residencial

Este checkout roda no servidor ativo da casa inteligente. Disponibilidade de
SSH, Home Assistant, Node-RED, MQTT e automações residenciais tem prioridade
sobre auditorias, builds e testes.

- Nunca execute duas validações pesadas, instalações NPM, clean-rooms ou suítes
  amplas em paralelo neste host.
- Antes de uma validação ampla, confira `uptime`, `free -h` e `df -h /`; não a
  inicie com menos de 2 GiB disponíveis, filesystem acima de 85% ou pressão já
  elevada.
- Use o alvo canônico, que reduz prioridade de CPU e I/O. Não contorne
  `scripts/run-resource-safe.sh` para acelerar a tarefa.
- Faça checks direcionados primeiro. Execute no máximo uma validação ampla no
  host por ciclo de mudança; repetições e clean-room devem ir para CI ou máquina
  isolada com limites de recursos.
- Interrompa imediatamente a carga iniciada pelo agente se SSH, dashboard ou
  serviços residenciais degradarem. Nunca reinicie o host ou a stack para
  concluir uma tarefa de repositório.
- Não use `make -j`, concorrência de testes ou múltiplos agentes neste host.

Essas regras também valem quando o usuário pede persistência ou validação
completa: persistência não autoriza sacrificar a disponibilidade residencial.
