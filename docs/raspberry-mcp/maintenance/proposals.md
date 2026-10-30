# Propostas operacionais — ainda não habilitadas

> Referência histórica da etapa ou candidato descrito. O catálogo e a admissão
> vigentes devem ser consultados no [índice operacional](../README.md).

Esta especificação delimita o que falta para a prioridade 2. Não concede permissão nem representa implementação pronta para executar. Cada contrato deve ter tests isolados e aprovação do escopo antes de ser exposto ao cliente MCP autorizado.

## Catálogo de manutenção somente de leitura

Candidatos exatos no projeto `/mnt/data/docker`:

- `scripts/process-git-backup-request.sh`
- `scripts/git-backup.sh`
- `scripts/process-update-stage-request.sh`
- `scripts/run-daily-host-update.sh`
- `scripts/offsite-backup.mjs`
- `scripts/container-readiness.mjs`

Admissão por conteúdo público versionado, hash revisado e recusa de alterações externas, symlinks ou conteúdo sensível. A inclusão para leitura não deve adicioná-los ao catálogo editável. Para esses workers executados diretamente do checkout, registrar o caminho lógico de execução e hash observado; isso não comprova que o worker terminou um ciclo. Para código MCP copiado em `/usr/local/lib`, comparar fonte com cópia instalada e registrar divergência.

## Validação dos workers

Contrato proposto `backup_worker_validate`: cópia temporária dos scripts admitidos, sintaxe e testes de fila/locks com executável de backup falso e diretório de trigger temporário. Deve bloquear herança de credenciais, acesso ao Docker e rede. Deve validar sucesso, deferred, falha, duplicação e reconciliação. Não executar `git push`, `daily-cycle`, restore ou os workers apontados para diretórios reais. Ainda falta adaptar a suíte para esse ambiente restrito.

## Implantação MCP

Contrato proposto `mcp_release_prepare/apply/status/revert`: apenas os módulos MCP de uma release imutável, revisada por hash. Preview inclui hashes fonte/instalado, validações, arquivos exatos e eventual reinício somente do túnel. Exigir registro durável antes de aplicar, lock exclusivo, verificação dos hashes instalados, probe de protocolo e de uma leitura sanitizada. Após timeout, consultar hashes e serviço antes de repetir. Rollback somente para release anterior preservada, sem tocar credenciais, dados ou serviços residenciais. Exige helper privilegiado restrito ainda não implementado nem autorizado.

## Backups

Contrato proposto `backup_retry_prepare`: não executa backup; informa pedido existente, produtor, lock, motivo, impacto e critérios de sucesso. Um eventual apply deve coalescer o pedido, usar o worker canônico, acompanhar o mesmo identificador e não remover locks. Backup Git pode realizar commit/push; é necessário aprovar explicitamente esse efeito e o destino antes de habilitar apply. Offsite pode envolver rede, criptografia e interrupção prevista pelo produtor; depende de escopo separado. Restauração real continua bloqueada até existir validação isolada e recuperação aprovada.

## Prontidão funcional

Propor sondas fixas, limitadas e sem credenciais: HTTP local do Home Assistant, endpoint de autenticação do Node-RED e handshake MQTT sem publicar/assinar tópicos. Resposta de autenticação recusada prova apenas que protocolo respondeu, não sucesso autenticado. Essas sondas exigem decidir explicitamente como alcançar o namespace do serviço sem liberar destinos arbitrários. Não usar o helper existente de MQTT que lê credenciais. Mesmo um probe bem-sucedido não comprova todas as automações residenciais.

## Reload e implantação residencial

Nenhuma operação genérica será oferecida. Cada componente precisa especificar arquivos exatos, validação, API/mecanismo nativo, impacto, timeout, prontidão e rollback. Em Node-RED, edição de função não equivale à geração e implantação de flows; os gates de layout, dry-run e observabilidade do repositório continuam obrigatórios. Home Assistant requer validação específica antes de reload. Alterações de volumes/bancos não terão downgrade automático.
