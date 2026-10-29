# Limites de processos nos ensaios de recuperação

`process-boundary.c` é um auxiliar de testes Linux, sem endpoint MCP, instalação
ou autorização própria. Ele não lê backups nem controla serviços residenciais.
O chamador precisa fornecer imagem, arquivos, rede, prazo e escopo já revisados.

O programa exige UID real, efetivo e salvo iguais e diferentes de zero, sem
capabilities efetivas, permitidas ou herdáveis. Ativa `no_new_privs`, fixa os
limites soft/hard e acrescenta um filtro seccomp ao filtro já existente.

| Perfil | Espaço de endereçamento do alvo | Supervisor |
| --- | --- | --- |
| `probe-64m` | 64 MiB | execução direta; somente teste |
| `application-2g` | 2 GiB | execução direta; somente processo único |
| `vm-1024m` | 1.024 MiB | PID 1 separado, limitado a 64 MiB |
| `vm-1280m` | 1.280 MiB | PID 1 separado, limitado a 64 MiB |
| `vm-1536m` | 1.536 MiB | PID 1 separado, limitado a 64 MiB |

O alvo pode criar threads que compartilhem VM, sinais e grupo de threads.
`fork`, `vfork`, clones sem essas propriedades, flags desconhecidas e
`io_uring_setup` são recusados. `clone3` retorna `ENOSYS` para permitir o fallback
de pthreads ao `clone` auditável. A ABI precisa ser AArch64 ou x86-64 little endian;
a ABI x32 é recusada. O limite de espaço de endereçamento inclui todas as threads
do mesmo grupo e permanece depois de `exec`.

Nos perfis de VM, o auxiliar cria exatamente um filho antes de instalar os
filtros em ambos os processos. O supervisor não executa o payload, é não
dumpável, usa relógio monotônico e encerra somente seu filho após 300 segundos
ou ao receber TERM/INT. O filho tem CPU limitada a 60 segundos; o supervisor,
a quatro. Ambos limitam descritores a 128 e desabilitam core dumps.

Isso não é um limite global de RAM equivalente a cgroup: arquivos temporários,
memória do kernel e processos externos precisam de limites e reserva separados.
O driver deve desabilitar healthchecks e `--init`, impedir `docker exec`,
verificar os dois grupos de processos, os limites nativos e todos os filtros
antes de liberar a VM pausada. Use somente mounts próprios revisados, rede
isolada, capabilities zeradas, PID/IPC privados e orçamento agregado explícito.
Sob pressão de recursos, encerre apenas o ensaio.

O modo de processo único não substitui a recuperação de aplicações com filhos,
como Home Assistant com supervisor e `go2rtc`. O ensaio de VM permite processos
adicionais dentro do guest, contidos pela memória da VM; isso ainda não comprova
que suas aplicações restauradas iniciam ou dispõem de memória suficiente.

TCG não oferece as garantias de segurança de isolamento de guest suportadas
pelo QEMU. O ensaio de recursos usa somente kernel e programa públicos revisados;
a contenção externa por namespaces, mounts, UID, capabilities e seccomp permanece
independente. Não admita dados ou aplicações privadas com base somente no cgroup
do guest ou nesse teste: revise a contenção externa e o escopo concreto antes.

## Construção e regressão

```bash
cc -std=c11 -O2 -Wall -Wextra -Werror -static \
  restore/process-boundary.c -o /tmp/recovery-process-boundary
node --test scripts/service-recovery-process-boundary.test.mjs
```

O teste compila em área temporária quando `cc` está disponível. Uma máquina sem
compilador pode fornecer `RECOVERY_BOUNDARY_TEST_BINARY`,
`RECOVERY_BOUNDARY_TEST_BINARY_SHA256` e
`RECOVERY_BOUNDARY_TEST_SOURCE_SHA256`: ambos os hashes precisam corresponder
ao binário explicitamente revisado e à fonte atual. Não há instalação automática
de compilador nem download de imagem.

A regressão usa somente processos locais descartáveis: threads reais, recusa de
fork/clone, impossibilidade de elevar o teto, alocação excessiva rejeitada,
memória compartilhada contabilizada e rejeição dos perfis de VM fora do PID 1.
O teste x86-64 também rejeita syscalls x32. O ensaio nativo separado usa uma
variante compilada com prazo de dois segundos para exercitar o watchdog;
essa variante não altera o prazo de 300 segundos da candidata normal.

Antes de executar um carregador ELF diretamente, confirme a permissão de
execução; uma biblioteca legível pode ainda não ser executável. Leitores de
`/proc/<pid>/limits` precisam tolerar espaços finais e verificar ambos os tetos.
Sockets Unix devem usar um caminho curto ligado ao diretório próprio aberto:
nomes longos de áreas de revisão podem exceder `sun_path`.

O aceite sanitizado descreve somente a fronteira de recursos. Restauração de
arquivos, prontidão dos sete serviços, rádio físico e autorização adicional de
chave/transferência permanecem etapas independentes. Não use uma prova de OOM
do guest para declarar recuperação das aplicações.

Referências primárias: [seccomp](https://man7.org/linux/man-pages/man2/seccomp.2.html),
[limites de recursos](https://man7.org/linux/man-pages/man2/getrlimit.2.html) e
[clone](https://man7.org/linux/man-pages/man2/clone.2.html).
Consulte também a [política de segurança do QEMU](https://www.qemu.org/docs/master/system/security.html).
