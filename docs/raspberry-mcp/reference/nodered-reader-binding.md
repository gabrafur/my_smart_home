# Catálogo limitado de binding do leitor Node-RED

Esta referência descreve o contrato instalado e as fontes versionadas em `scripts/raspberry-mcp/runtime-source/nodered-reader-binding/`. O mapa de proveniência registra a comparação dos oito módulos e da composição do frontend com as fontes instaladas; isso não comprova autorização atual, saúde da rede ou aplicação, nem execução de qualquer cliente. A capacidade ajusta a permissão de rede de um serviço de diagnóstico existente; não faz deploy do Node-RED nem altera seus fluxos. A política, as identidades de rede, a aprovação e o ledger são externos e não fazem parte da distribuição pública.

## Contrato e limites

As ações fechadas são `nodered_plan_reader_binding`, `nodered_apply_reader_binding`, `nodered_plan_restore_reader_binding`, `nodered_restore_reader_binding` e `nodered_revoke_reader_binding`. As quatro primeiras usam os métodos existentes de aplicação, status e reconciliação; a última usa exclusivamente `admin_action_revoke`, que não aceita as outras ações de binding. A requisição aceita apenas host lógico, ação enumerada e chave de idempotência no formato fixo. Não aceita comando, caminho, rede ou endereço escolhido pelo chamador.

A prévia fixa a instância e imagem do container, rede, peer, hash da unit e permissões anteriores. O efeito substitui somente um peer IPv4 `/32` por aquele derivado do container revisado, preservando as três entradas base. A chamada ao systemd altera `IPAddressAllow` em propriedade de runtime do serviço fixo de diagnóstico; não reinicia serviço. Antes da escrita, o código exige leitor inativo, comparação da lista atual com a prévia, identidade preservada, capacidade do host, ausência de revogação e intent persistido. A verificação posterior compara novamente instância e permissão. O efeito é transitório no âmbito do systemd runtime; a persistência ou a saúde após reinício não são garantidas pelo recibo.

Há no máximo quatro tentativas de escrita contabilizadas por 24 horas e espaçamento mínimo de 600 segundos. A prévia expira após 900 segundos. Intent incerto também consome orçamento; não há repetição automática. A política vigente mantém `recurring_execution_enabled: false`; a política separada de eventos do cliente declara `server_scheduling_enabled: false`. O catálogo declara confirmação da interface necessária, mas esse atributo não comprova que o cliente tenha mostrado ou recebido a confirmação: isso depende da interface e deve ser verificado na integração real. A autorização para um efeito não deve ser inferida da simples descoberta do catálogo.

## Eventos do cliente e elegibilidade

A descoberta em `maintenance_capabilities` expõe `client_event_policy` separadamente da admissão do executor. A projeção informa fonte, horário de observação, idade, erro de coleta, estado, aprovação, cobertura e se há prova de execução. Uma aprovação de cliente não substitui a admissão e os gates nativos, nem comprova que o cliente tenha executado uma ação. A ausência, revogação ou falha de verificação não concede aprovação. A política não cria agenda no servidor nem dispensa as confirmações da interface.

A política de cliente cobre somente falha natural do leitor de diagnóstico, com origem e horário identificados, idade de até 300 segundos e erro de coleta `NodeRED_runtime_collection_unavailable`, acompanhado de `runtime_collection_unavailable` ou `socket_timeout`. A confirmação deve incluir descoberta `project_files` para a categoria `nodered` e offset zero. Erro isolado em fluxo, identidade inválida, revogação, falta de autorização, ocupação, cooldown ou expiração de cache não comprovam essa falha elegível. Se a descoberta funcionar, a investigação prossegue sem alterar o vínculo.

Em `project_files`, o catálogo estático pode responder com `collection_error: null`
enquanto o leitor falha. Avalie o objeto separado `runtime_observation`: sua fonte,
horário, idade, erro e razão descrevem a coleta runtime. O sucesso do catálogo
estático não comprova o funcionamento do leitor. A idade deriva do horário da
fonte, sem renová-lo a cada leitura; horário ausente, inválido ou futuro produz
idade desconhecida e erro explícito, em vez de dado recente. Uma falha de coleta
acabada de observar pode ter idade zero e estado da aplicação desconhecido.

Um plano `planned`, válido e sem resultado incerto pode ser seguido de uma aplicação com a mesma chave, mantendo a confirmação da interface; a política do cliente limita a uma aplicação por incidente. `no_change`, recusa ou estado desconhecido não autorizam aplicação. Depois de aplicar, uma nova descoberta e leitura runtime sem erro, posteriores ao efeito, são necessárias para afirmar que o leitor voltou a responder; isso não demonstra saúde dos fluxos ou da casa. Não há restauração, reinício, tarefa ou efeito em dispositivo automáticos por essa política.

Antes do intent de aplicação ou restauração, o executor pode observar o leitor até ficar inativo por no máximo 30 segundos e 16 consultas. A espera é somente observacional, sem reiniciar o leitor. Após ela, o executor revalida admissão, prazo da prévia, identidade e valores antes de persistir o intent. Se não confirmar inatividade ou outro gate falhar, não há escrita.

## Correlação canônica e proteção contra repetição

Uma falha atual elegível pode solicitar a prévia já autorizada para obter a
associação do alvo atual. A descoberta passiva explica esse procedimento em
`incident_correlation`; não consulta Docker/systemd, não afirma conhecer a
instância atual e não enumera o histórico privado. A prévia verifica o mesmo
alvo fixo e retorna uma chave opaca derivada no servidor da instância, unidade
lógica e mudança de permissões. Horário, chave escolhida pelo cliente ou uma
revisão de código da unidade não tornam a mesma mudança um incidente novo.
Os controles normais continuam validando a identidade e a versão atual.

Se a prévia encontra a operação canônica já existente, retorna seu identificador
com `existing_operation: true` e `observe_only: true`, sem criar uma operação
alias. O cliente acompanha esse recibo; não aplica usando uma chave nova. O
servidor volta a verificar a correlação antes de um intent, inclusive quando
existiam dois planos antigos. Uma operação aplicada ou restaurada não ganha
outro efeito pela troca de chave. Resultados incertos bloqueiam novas prévias;
status e reconciliação permanecem na operação original.

Uma prévia nova identifica a associação atual verificada, mas a correlação não
concede o efeito. São necessários estado `planned`, relógio válido, confirmação
da interface e todos os gates existentes. Planos vencidos comprovadamente sem
efeito podem receber uma nova prévia vinculada por
`prior_no_effect_preview_operation_id`: o recibo e o vencimento anteriores são
preservados. Isso não renova um intent, não repete uma aplicação e não autoriza
recriar operações incertas. A proteção de orçamento persiste entre processos e
contabiliza também restaurações.

## Transporte e fronteiras de confiança

O cliente nativo usa prazo de 48 segundos, abaixo dos 50 segundos do frontend. Timeout ou perda de resposta não comprovam ausência de efeito: observe e reconcilie a mesma operação, sem repetição automática.

O broker opera com UID fixado e encaminha a família de ações ao cliente do socket Unix existente. O servidor privilegiado, iniciado pelo bootstrap e recebido por ativação de socket, usa `SO_PEERCRED` para exigir o UID previsto do cliente; valida tamanho, enquadramento e chaves duplicadas e não devolve exceções arbitrárias. Frames de outras famílias são delegados ao servidor anterior cuja identidade é pinada. O bootstrap verifica proprietário, modo, conteúdo e hashes do conjunto exato antes de importar buffers verificados; os papéis de servidor e broker exigem UIDs distintos. O broker também consulta o guardião de componentes via socket, confere identidade root do socket e do peer e falha fechado para efeitos quando a reserva não puder ser confirmada.

A identidade do socket não substitui autorização de negócio ou confirmação da interface. As verificações de UID, hashes, modos e caminhos são específicas do ambiente instalado; elas não constituem um mecanismo portátil de autenticação entre máquinas ou modelos.

O adaptador nativo consulta o Docker por um único método e caminho literais para obter metadados do container, com prazo e tamanho limitados. Verifica nome, labels Compose, rede e listener; descarta os campos restantes, inclusive ambiente, sem exportá-los ao MCP. **Um bind somente leitura de socket Unix não restringe métodos da API Docker**: a fronteira entre método permitido e acesso mais amplo é o código selado e sua implantação, não uma ACL do socket. O comando systemd é igualmente fechado, executado sem shell, com binário verificado e ambiente restrito. Não há interface de comandos arbitrários.

## Resultado incerto, reconciliação e restauração

O ledger registra o intent antes do comando. Falha, timeout ou verificação posterior inconclusiva resultam em `outcome_unknown` ou `restore_unknown`, sem supor sucesso ou repetir a escrita. Use status e reconciliação da mesma operação: a reconciliação somente observa a instância e a lista, podendo classificar o valor esperado ou anterior; não comprova quem realizou a alteração. Se a instância mudou ou a lista corresponde a um valor estrangeiro, preserva-se o estado e é necessária investigação; não se reaplica automaticamente.

Para desfazer uma operação aplicada, solicite uma prévia de restauração própria e recente. A restauração compara a instância e os valores, e retorna somente ao valor anterior guardado naquela operação. Uma prévia expirada, alteração externa, leitor ativo ou conflito impede o efeito. Não apague ledger, locks ou recibos para liberar uma operação: isso removeria evidência e controles de concorrência e orçamento. A ação de revogação cria o marcador fixo, fecha novas admissões e a aprovação de eventos do cliente, preservando ledger, histórico e cotas. Não reativa o catálogo nem comprova cancelamento de operação já em andamento; recibos continuam disponíveis para observação e recuperação. A consulta ao catálogo é um retrato da política e do ledger, não uma verificação atual de saúde do serviço.

## Mapa de dependências

| Módulo | Papel e dependências |
| --- | --- |
| `bootstrap.py` | Verifica bundle e pin de política antes de carregar os demais módulos; separa papéis por UID. |
| `broker.py` | Compõe broker legado, roteia ações e consulta o guardião de componentes. Depende do broker legado e do socket do guardião. |
| `client.py` | Cliente fechado do socket do executor existente. |
| `server.py` | Fronteira root com `SO_PEERCRED`, enquadramento e delegação ao servidor legado pinado. |
| `runtime.py` | Valida política externa e hashes, conecta controlador, store e adaptador, e projeta admissão passiva. |
| `controller.py` | Máquina de estados, prévias, cotas, reconciliação e regras de restauração. |
| `durable_store.py` | Ledger protegido, locks próprios e compartilhados, escrita atômica e detecção de alteração concorrente. |
| `native_manager.py` | Validação de container, rede, unit e dependências; consulta Docker fixa e chamada systemd restrita. |

A implantação ainda depende do serviço de diagnóstico e seus dois arquivos auxiliares, unit e drop-in esperados, binário systemctl, socket e alias Docker, executor e broker anteriores, guardião de componentes, lock compartilhado, diretório de estado protegido e política de hashes específica do ambiente. Sua presença nas fontes não confirma configuração ou funcionamento desses componentes.

## Instalação e recuperação: lacunas para reprodução

Não existe neste pacote um instalador público, manifesto de implantação completo, definição revisada dos binds e unidades, nem política pública que se possa aplicar. Não há instrução reproduzível para criar ou copiar a aprovação privada, tampouco os pins da instalação atual; não se deve inventá-los ou publicar seus valores. Copiar os módulos não instala nem habilita a capacidade.

Antes de uma futura implantação, é necessário publicar e revisar as fontes e testes de todas as dependências relevantes, um procedimento de instalação idempotente e reversível, manifesto de arquivos/modos/UIDs/sockets/binds e limites de privilégio, e um mecanismo para produzir e aprovar localmente a política específica sem exportar segredos, IPs ou identificadores. O procedimento precisa fixar hashes do bundle, binário, dependências e delegados, preservar a cadeia anterior, reconciliar os pontos de entrada e demonstrar rollback sem apagar ledger. Deve prever testes sintéticos e validação controlada da integração efetiva, incluindo transporte, guardião, concorrência, falha após intent, reconciliação e prévia de restore. Até então a recuperação de uma instalação real requer o procedimento operacional aprovado para aquele ambiente; este documento não autoriza gerar nova política, alterar unidades ou reiniciar serviços.

## Portabilidade entre clientes e modelos

O contrato é expresso por ferramentas, estados e confirmações, não por um modelo específico. Um cliente ou modelo diferente precisa manter a mesma chave de operação, ler a prévia, apresentar a confirmação exigida, respeitar recusa e estado incerto e usar status/reconciliação sem repetição automática. Ele não deve promover metadados de catálogo a prova de efeito ou saúde. A compatibilidade da interface, autenticação e tratamento de confirmação deve ser testada para cada cliente; trocar de modelo não concede autorização adicional nem garante que os controles de interface estejam ativos.

## Inventário de implantação e revisão local

Este manifesto registra o que as fontes e os metadados acessíveis mostraram na instalação examinada. É uma base para revisão local, não um instalador, autorização, receita automática ou garantia de reconstrução. Os valores privados são representados por `<local>`; o operador autorizado deve obtê-los e conferi-los no próprio host, sem copiá-los para documentação pública. Não publicar a política, ledger, identificadores, endereços ou hashes da configuração. Verificar as units efetivas e seus drop-ins no momento da mudança: uma lista de arquivos em disco não prova quais montagens e propriedades estão ativas em um processo.

### Inventário fixo

| Item | Caminho ou unidade | Identidade observada ou exigida |
| --- | --- | --- |
| Bundle | `/usr/local/lib/raspberry-nodered-binding/` com `bootstrap.py`, `broker.py`, `client.py`, `controller.py`, `durable_store.py`, `native_manager.py`, `runtime.py`, `server.py` | Diretório root:root 0755 e módulos root:root 0644 observados; verificações de identidade e hashes pelo bootstrap. |
| Política privada | `/usr/local/lib/raspberry-nodered-binding/approval.json` | Arquivo local pinado; conteúdo, hashes de configuração, endereços, IDs, seeds e validade não exportados. Revisar localmente identidade e conteúdo segundo a política de acesso, sem incorporá-los ao pacote. |
| Estado | `/var/lib/raspberry-nodered-binding/` | Diretório root:root 0700 observado; ledger, lock e marcador de revogação são estado protegido, não parte da distribuição. Store exige arquivos protegidos root 0600 e não segue links. |
| Lock compartilhado | `/mnt/data/docker/.daily-maintenance.lock` → `/run/raspberry-storage-inputs/daily-maintenance.lock` | Bind somente leitura configurado no drop-in de armazenamento. A política fixa identidade do objeto no namespace; obter e verificar localmente dispositivo/inode e UID/GID/modo esperados, sem publicar valores privados. O placeholder visível fora do namespace não comprova o bind efetivo. |
| Métricas para headroom | `/mnt/data/docker/.local-state/storage-maintenance` → `/run/raspberry-storage-inputs/metrics` | Bind existente de armazenamento; verificar montagem efetiva e identidade local, sem incluir dados de estado. |
| Delegados anteriores | `/usr/local/lib/raspberry-mcp-storage/server.py`, `/usr/local/lib/raspberry-mcp-storage/broker.py` | root:root 0644 observados; runtime exige hashes fixados localmente na política. É necessário preservar toda a cadeia anterior. |
| Dependências do leitor | `/usr/local/lib/raspberry-nodered-diagnostics/sidecar.cjs`, `/usr/local/lib/raspberry-nodered-diagnostics/root_snapshot.py` | root:root 0644 observados; hashes conferidos localmente antes de inspecionar ou atuar. |
| Unit do alvo | `/etc/systemd/system/raspberry-nodered-diagnostics.service` | Usuário local de serviço e grupo `raspberry-mcp`; verificar proprietário, modo, hash, estado efetivo, negação geral e permissões localmente. Não publicar endereços. |
| Drop-in dinâmico do alvo | `/run/systemd/system.control/raspberry-nodered-diagnostics.service.d/50-IPAddressAllow.conf` | Quando presente, o código exige formato e valores consistentes com o estado systemd; não substituir ou apagar ao encontrar conteúdo estrangeiro. |
| Executável | `/usr/bin/systemctl` | Arquivo executável root confiável, hash e identidade fixados e verificados pelo adaptador; o hash aplicável deve ser conferido localmente. |
| Socket do executor | `raspberry-admin-executor.socket` → `/run/raspberry-admin-executor.sock` | root:`raspberry-mcp`, modo 0660 observados; servidor valida `SO_PEERCRED` do cliente previsto. |
| Guardião | `raspberry-component-guard.socket` → `/run/raspberry-component-guard.sock` | root:`raspberry-mcp`, modo 0660 observados; broker confere tipo, propriedade, modo e UID root do peer. |
| Ponte Docker | `/run/docker.sock` → `/run/raspberry-nodered-binding-inputs/docker.sock` | Bind somente leitura opcional na unit do executor; o socket continua permitindo operações da API conforme o código que o usa. O placeholder host não comprova o bind dentro do namespace. |
| Entradas systemd | `raspberry-admin-executor@.service` e `raspberry-mcp-operations@.service`, ambos com drop-in `zzzzzzz-nodered-reader-binding.conf` | O drop-in seleciona bootstrap com hashes localmente pinados; servidor root, broker UID 1001, verificados pelo bootstrap. Não publicar pins da política. |

A unit base do executor usa rede privada, famílias de endereço restritas a Unix, `NoNewPrivileges` e proteções de sistema; os drop-ins existentes acrescentam estado gravável e binds. A unit de operações tem seu próprio sandbox e seus demais drop-ins. A unit de diagnóstico tem outros binds e dependências funcionais que devem ser preservados integralmente; este inventário não autoriza removê-los ou substituí-los. Conferir ordem e conteúdo efetivo de todos os drop-ins relevantes, não apenas o arquivo com nome mais tardio.

### Sequência de revisão e recuperação

1. Identifique localmente as units, drop-ins, arquivos e delegados efetivos, usuários, permissões, montagens em namespace e pins aplicáveis. Compare código instalado com fontes revisadas e inventarie qualquer divergência. Não copie a política nem valores privados para logs, artefatos públicos ou conversas.
2. Revise o plano de mudança e confirme a autorização aplicável ao efeito específico. Antes de agir, preserve em local privado protegido os arquivos de código, units e drop-ins que seriam alterados, seus metadados e pins, e um inventário da cadeia anterior. Proteja política e ledger existentes; garanta consistência de backup sob o procedimento de locks do ambiente. Não sobrescreva ou restaure ledger por conveniência: isso pode apagar intent e orçamento recentes.
3. Prepare fora do runtime o bundle e os testes revisados, manifesto de permissões e plano de reversão. Confira as dependências e mudanças de hash de forma coerente em todas as entradas. A política específica e sua aprovação devem ser tratadas localmente pelo responsável autorizado; não é fornecido aqui gerador de aprovação.
4. Antes de aplicar qualquer pacote, confira saúde e margem de recursos do host, ausência de operações incertas e alterações concorrentes. A instalação e eventual recarga devem seguir um procedimento revisado que preserve serviços residenciais e limite a intervenção ao necessário. Não há neste documento uma sequência executável ou garantia de que uma alteração possa ser aplicada sem interrupção.
5. Após a mudança, valide primeiro a cadeia e a admissão passiva. A confirmação de interface, estado de rede e execução são evidências distintas. Um preflight disponível apenas com política desativada não comprova o caminho produtivo completo. Qualquer verificação com efeito requer autorização adequada e planejamento separado.
6. Em falha, interrompa novas tentativas. Preserve recibos e evidências; se houver intent incerto, use status e reconciliação da mesma operação e não repita a escrita. Uma alteração aplicada só pode ser restaurada pelo plano de restore próprio e fresco, com comparação de estado. Se instância ou valor divergir, preserve a condição para investigação. Para reverter implantação de código/units, o operador deve usar backups privados revisados e uma sequência específica que mantenha coerentes bundle, pins, delegados e unidades; este manifesto não fornece um rollback automático validado. Não restaure o ledger para um ponto anterior nem reinicie host ou stack como atalho.

### Pendências para instalação reproduzível

Publicar e revisar manifesto executável e instalador idempotente, definição completa dos serviços e mounts, mecanismo local de provisionamento e aprovação sem dados privados, preservação e validação dos delegados, testes isolados e de integração, backup consistente e rollback ensaiado. Confirmar a proteção efetiva do socket Docker e a execução do guardião no namespace real. Até existir evidência dessas etapas, tratar a instalação como específica do host e não afirmar que este documento a reconstrói.

## Ausência de pedidos nas montagens opcionais

O snapshot Kia não pode tratar a existência do destino de um bind opcional como
prova de solicitação. Quando a fonte desaparece, um destino vazio antigo pode
continuar existindo no namespace. `root_snapshot.py` exige a montagem somente
leitura da fonte fixa correspondente e verifica tipo e dispositivo; identidade
inconsistente ou leitura indeterminada produz desconhecido. Arquivo realmente
montado e vazio não é confundido com destino sem montagem.

Esses indicadores descrevem a montagem observada na ativação do leitor, com o
horário do snapshot; não constituem acompanhamento contínuo da fila. A projeção
MCP conserva essa limitação explicitamente. Não enviar auditoria ou reparo com
base apenas nesses indicadores: reconciliar o recibo e a origem admitida antes
de qualquer efeito. Os testes usam arquivos e mountinfo sintéticos, sem pedidos
ou comandos residenciais.
