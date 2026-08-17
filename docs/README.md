# Documentação

[Português (principal)](README.md) · [English](README.en.md)

Este índice separa os documentos de referência atual dos registros históricos.
Os nomes de entidades e dispositivos encontrados nos guias de funcionalidades
são identificadores da configuração versionada; endereços, credenciais,
coordenadas, MACs e identificadores físicos reais devem aparecer somente como
placeholders.

## Comece aqui

| Documento | Quando usar | Inglês |
| --- | --- | --- |
| [Instalação e restauração](INSTALACAO_RESTAURACAO_SMART_HOME.md) | Clone novo, recuperação ou migração de host | [English](INSTALLATION_RESTORE.en.md) |
| [Containers](CONTAINERS.md) | Imagens, portas, volumes, dependências e operação | [English](CONTAINERS.en.md) |
| [Revisão semanal da documentação](REVISAO_DOCUMENTACAO_SEMANAL.md) | Agendamento, escopo, credenciais e recuperação | [English](WEEKLY_DOCUMENTATION_REVIEW.en.md) |
| [Auditoria de segurança](AUDITORIA_SEGURANCA_REPO_PUBLICO.md) | Publicação, rotação e histórico Git | resumo no [índice em inglês](README.en.md) |
| [Bluetooth e Matter](BLUETOOTH_MATTER.md) | D-Bus, rede do host e comissionamento | resumo no [guia de containers em inglês](CONTAINERS.en.md) |
| [Saúde do Raspberry Pi](RASPBERRY_PI_SYSTEM_HEALTH.md) | Métricas e alertas do host | resumo no [índice em inglês](README.en.md) |
| [Monitoramento de infraestrutura](ZIGBEE_HEALTH_NOTIFICATIONS.md) | Queda e recuperação de Zigbee e Internet no Node-RED | [English](ZIGBEE_HEALTH_NOTIFICATIONS.en.md) |
| [Bridge no Home Assistant](CHAT_CLAUDE_CODE_HA.md) | Claude Code/Codex na interface | resumo no [guia de containers em inglês](CONTAINERS.en.md) |
| [Codex + Local AI com RTX 4070](LOCAL_AI_RTX_4070.md) | Inferência local, rede, telemetria e reprodução em fork | guia detalhado em português |
| [Memória versionada dos agentes](MEMORIA_VERSIONADA_AGENTES.md) | Autoridade, privacidade, manutenção e validação da memória de IA | guia detalhado em português |
| [Modelo de privacidade](PRIVACY_MODEL.md) | Papéis públicos, sanitização, scanner e memória pública | [English](PRIVACY_MODEL.en.md) |
| [Fronteira pública e privada](PUBLIC_PRIVATE_BOUNDARY.md) | Bindings, bootstrap, degradação segura e compatibilidade | [English](PUBLIC_PRIVATE_BOUNDARY.en.md) |

## Funcionalidades

- [Iluminação externa no Node-RED](ILUMINACAO_EXTERNA_NODERED.md)
- [Alarme da casa no Node-RED](ALARME_CASA_NODERED.md)
- [Contexto de chegada e iluminação de segurança no Node-RED](ILUMINACAO_SEGURANCA_NODERED.md)
- [Inventário de estado e recovery dos flows de segurança](SECURITY_CONTEXT_RECOVERY_STATE_INVENTORY.md)
- [Desarme do alarme na chegada](ALARME_DESARME_CHEGADA_NODERED.md)
- [Integração Moni Mobile / Intelbras](INTEGRACAO_MONI_MOBILE_INTELBRAS.md)
- [Integração Hyundai/Kia](VEHICLE_PRIMARY_KIA_UVO_INTEGRATION.md)
- [Portão: relé local](PORTAO_GARAGEM_RELE_LOCAL.md)
- [Portão: botão de pulso](PORTAO_GARAGEM_BOTAO_PULSO.md)
- [Controle de energia](CONTROLE_ENERGIA_HOME_ASSISTANT.md)
- [Wake-on-LAN da TV](WAKE_ON_LAN_TV_SALA.md)

## Registros históricos

- [Auditoria do repositório público](AUDITORIA_SEGURANCA_REPO_PUBLICO.md)
- [Handoff da limpeza do histórico](HANDOFF_LIMPEZA_HISTORICO_GIT.md)

Esses arquivos preservam datas e incidentes para explicar decisões. Uma seção
histórica pode mencionar uma versão antiga ou um comportamento corrigido, mas
deve marcá-lo explicitamente como histórico e apontar para o estado atual.

## Política de manutenção

- Português do Brasil é o idioma principal.
- README, índice, containers, instalação/restauração, revisão semanal e recursos marcados como
  bilíngues têm versão completa em inglês.
- Mudanças de porta, volume, variável, imagem ou procedimento devem atualizar
  as duas versões do guia correspondente na mesma alteração.
- Exemplos usam `IP_DO_HOST`, `IP_DO_COORDENADOR`, `USUARIO_MQTT` ou endereços
  reservados para documentação; nunca valores reais da residência.
- Links, pares bilíngues, memória pública e privacidade mecanicamente
  verificável fazem parte de `make validate-public`.
