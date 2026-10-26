# Events nativos com resumos de estado

Código exportado do serviço ativo. Não contém banco, callback, chaves,
assinaturas, políticas privadas ou autorização de implantação. O catálogo e os
parâmetros MCP existentes não mudam; `events_status` recebe host raspberry.
Não execute o worker ou transporte para testar a instalação: aguarde o ciclo
natural e preserve o orçamento de seis tentativas por 24h e intervalo de 600s.

`notification_summary_v1` agrupa todas as revisões elegíveis por notificação,
até oito notificações por tentativa. Estado atual vem do snapshot fresco;
notificações atuais e mudanças mais recentes precedem remoções antigas.
Remoção não é recuperação. Falta de evidência continua unknown. O envelope
usa ID determinístico; eventos e IDs originais, membros, transições e intent
ficam vinculados no ledger. Intent e membros são atômicos antes do transporte.
Resposta incerta exclui todos os membros de reenvio; uma revisão nova é outro
fato, não retry da tentativa antiga. Não exporta título/mensagem nesse resumo.

Registros que saem da janela elegível vão para arquivo com motivo explícito,
até 4.096 entradas, sem descarte silencioso. Arquivo cheio ou limite SQLite
existente de 16 MiB atingido falha fechado. Não remova intents ou recibos
incertos para liberar capacidade. Retenção de arquivo não autoriza replay.

`events_status` informa delivery_summary_version, delivery_queue e
delivery_opportunity: eventos elegíveis/grupos/revisões agrupáveis, idade,
arquivo, batches/membros duráveis, bloqueio, próximo slot e compatibilidade
com a validade da assinatura. Oportunidade não é promessa de entrega.
`maintenance_capabilities.evidence.data.events.current_observation.delivery.summary`
contém projeção fechada dos mesmos agregados. Erro de coleta não vira fila vazia.
Aceite do webhook e execução do assistente continuam provas distintas.

Atualização exige comparar bases, instalar código root:root/0644 e atualizar
somente os pins correspondentes pela cadeia existente, sem trocar autenticação,
IDs, orçamento, prazo ou políticas de segurança. O serviço Events precisa
recarregar os módulos. Frontend MCP persistente também pode manter um import
ESM antigo: testar a chamada real e, se necessário, reconectar somente o túnel
existente com mesma configuração. Não reiniciar serviços domésticos para isso.

Reversão preserva banco e membros e deixa Events parado. O código antigo não
conhece membros de resumo; reiniciá-lo pode causar replay. A retomada exige
revisão de compatibilidade. Não reaplicar manifestos de base antiga sobre
políticas atualizadas nem substituir arquivos que outra operação modificou.

Os 53 testes Python e os testes de projeção são sintéticos: não enviam webhook,
criam assinatura real, executam assistente ou comandam dispositivo. Participam
da validação pública. Instalação, leitura MCP, entrega natural e execução do
assistente exigem evidências separadas; testes ou catálogo não as substituem.
