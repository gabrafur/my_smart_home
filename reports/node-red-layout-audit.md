# Auditoria de layout dos canvases Node-RED

## Escopo e método

Baseline auditado: snapshot temporário anterior à mudança (SHA-256 `3411d46c3b20e1e8c3b0e4aa0eec801749e9622609678c2808b4f4a09cf14412`).

Esta é a medição **antes** da padronização. A análise é conservadora e combina topologia e geometria aproximada: dimensões visuais estimadas pelo renderizador do repositório, distância entre retângulos, direção dos wires, dispersão das branches e interseção de segmentos entre centros. Cruzamentos e proximidades são candidatos para inspeção visual, não prova de defeito funcional. Links virtuais entre tabs não são tratados como wires locais.

Limites usados: margem esquerda de 64 px; node praticamente encostado quando a folga estimada é menor que 20 px; gap excessivo quando um wire mede mais de 500 px; retorno quando o destino fica mais de 30 px à esquerda da origem; mudança vertical potencialmente em zig-zag quando supera 220 px com avanço horizontal inferior a 180 px; concentração quando um node soma pelo menos seis entradas e saídas locais.

## Resumo por canvas

| Canvas | Tipo | Nodes | Groups | Área aproximada (px) | Margem | Sobreposições | Próximos | Gaps >500 | Retornos | Zig-zags | Branches desalinhadas | Concentrações | Cruzamentos possíveis | Testes (nodes / conflitos) | Classificação |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| recorder_retention | tab | 59 | 5 | 2622 × 1132 | 64 | 0 | 15 | 0 | 0 | 0 | 1 | 2 | 0 | 18 / 2 | **NEEDS REORGANIZATION** |
| revisao_documental_semanal | tab | 42 | 3 | 3288 × 662 | 64 | 0 | 7 | 0 | 0 | 0 | 0 | 1 | 1 | 17 / 2 | **MINOR CLEANUP** |
| garagem | tab | 62 | 6 | 2857 × 1072 | 28 | 0 | 19 | 0 | 0 | 0 | 2 | 0 | 2 | 17 / 5 | **NEEDS REORGANIZATION** |
| integracoes_compartilhadas | tab | 7 | 1 | 1256 × 142 | 724 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 | **GOOD** |
| iluminacao_externa | tab | 69 | 4 | 4162 × 902 | 64 | 0 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 19 / 0 | **MINOR CLEANUP** |
| alarme_casa | tab | 71 | 6 | 3142 × 1182 | 64 | 0 | 7 | 0 | 0 | 0 | 0 | 1 | 0 | 19 / 0 | **MINOR CLEANUP** |
| resfriamento_raspberry_pi | tab | 113 | 5 | 5562 × 1542 | 64 | 0 | 17 | 0 | 0 | 1 | 1 | 1 | 3 | 0 / 0 | **NEEDS REORGANIZATION** |
| storage_health | tab | 135 | 7 | 11472 × 1462 | 54 | 0 | 9 | 1 | 0 | 1 | 2 | 0 | 6 | 16 / 1 | **NEEDS REORGANIZATION** |
| localizacao_pessoas | tab | 102 | 8 | 5312 × 1774 | 68 | 0 | 27 | 0 | 0 | 0 | 2 | 2 | 1 | 22 / 13 | **NEEDS REORGANIZATION** |
| contexto_vehicle_primary | tab | 229 | 13 | 8224 × 2751 | 73 | 0 | 32 | 0 | 0 | 0 | 4 | 8 | 2 | 28 / 6 | **NEEDS REORGANIZATION** |
| iluminacao_seguranca | tab | 146 | 10 | 6134 × 2087 | 106 | 0 | 8 | 1 | 0 | 0 | 2 | 3 | 5 | 10 / 0 | **NEEDS REORGANIZATION** |
| atualizacoes_diarias | tab | 251 | 14 | 2437 × 6464 | 68 | 0 | 14 | 0 | 0 | 0 | 6 | 2 | 7 | 82 / 7 | **NEEDS REORGANIZATION** |
| guardiao_memoria_host | tab | 79 | 5 | 6616 × 895 | 66 | 0 | 10 | 0 | 0 | 0 | 1 | 3 | 0 | 24 / 0 | **NEEDS REORGANIZATION** |
| contexto_chegadas | tab | 120 | 7 | 7853 × 1544 | 64 | 0 | 17 | 0 | 0 | 9 | 9 | 0 | 1 | 12 / 2 | **NEEDS REORGANIZATION** |
| monitoramento_vpn | tab | 77 | 7 | 7937 × 1164 | 64 | 0 | 8 | 0 | 0 | 0 | 0 | 1 | 0 | 22 / 5 | **NEEDS REORGANIZATION** |
| alarme_desarme_chegada | tab | 97 | 7 | 3914 × 1674 | 228 | 0 | 4 | 0 | 0 | 0 | 7 | 0 | 0 | 33 / 1 | **MINOR CLEANUP** |
| recuperacao_rtx | tab | 92 | 6 | 6782 × 1244 | 64 | 0 | 11 | 0 | 0 | 0 | 3 | 0 | 7 | 29 / 8 | **NEEDS REORGANIZATION** |
| alertas_codex | tab | 80 | 7 | 4192 × 1362 | 34 | 0 | 15 | 0 | 0 | 0 | 1 | 2 | 1 | 18 / 0 | **NEEDS REORGANIZATION** |
| backup_git | tab | 56 | 5 | 2802 × 932 | 24 | 0 | 8 | 0 | 0 | 1 | 0 | 0 | 2 | 20 / 4 | **NEEDS REORGANIZATION** |
| monitoramento_internet | tab | 74 | 5 | 5072 × 1027 | 25 | 0 | 11 | 0 | 0 | 1 | 1 | 0 | 1 | 17 / 0 | **NEEDS REORGANIZATION** |
| monitoramento_zigbee | tab | 123 | 6 | 7748 × 1842 | 33 | 0 | 6 | 0 | 0 | 1 | 3 | 0 | 4 | 27 / 1 | **NEEDS REORGANIZATION** |
| monitoramento_tuya | tab | 116 | 5 | 7888 × 1572 | 33 | 0 | 11 | 0 | 0 | 1 | 0 | 2 | 0 | 27 / 1 | **NEEDS REORGANIZATION** |
| notificacoes_chegadas_residentes | tab | 89 | 7 | 9142 × 1132 | 24 | 0 | 10 | 0 | 0 | 0 | 3 | 2 | 0 | 21 / 1 | **NEEDS REORGANIZATION** |
| observabilidade_global | tab | 60 | 3 | 3492 × 1222 | 64 | 0 | 13 | 0 | 0 | 0 | 0 | 1 | 3 | 16 / 3 | **NEEDS REORGANIZATION** |
| Notificar celulares, Echo e Home Assistant | subflow | 6 | 0 | 569 × 234 | 122 | 0 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 | **MINOR CLEANUP** |

## Áreas que exigem atenção

- **recorder_retention — NEEDS REORGANIZATION:** 15 par(es) praticamente encostado(s); 1 branch(es) com destinos desalinhados; 2 ponto(s) de concentração de wires; 2 conflito(s) potencial(is) na área de testes. Pontos mais carregados: `Decisão: baseline, mudança, outlier ou descarte?`, `Estado: mudança preservada`, `Dry-run de purge`, `Estado: outlier preservado`.
- **revisao_documental_semanal — MINOR CLEANUP:** 7 par(es) praticamente encostado(s); 1 cruzamento(s) geométrico(s) possível(is); 1 ponto(s) de concentração de wires; 2 conflito(s) potencial(is) na área de testes. Pontos mais carregados: `Registrar falha real`, `Rejeitar resposta desconhecida`, `Helper aceitou, agrupou ou rejeitou?`, `Ponte finalizada`.
- **garagem — NEEDS REORGANIZATION:** margem esquerda de 28 px; 19 par(es) praticamente encostado(s); 2 branch(es) com destinos desalinhados; 2 cruzamento(s) geométrico(s) possível(is); 5 conflito(s) potencial(is) na área de testes. Pontos mais carregados: `Gate final: OFF seguro ou TESTE?`, `Gate final: pulso produção ou TESTE?`, `Adaptar MQTT: fechar contato (ON)`, `TESTE → terminal dry-run`.
- **integracoes_compartilhadas — GOOD:** nenhum candidato geométrico relevante detectado automaticamente.
- **iluminacao_externa — MINOR CLEANUP:** 6 par(es) praticamente encostado(s). Pontos mais carregados: `2d743b91576b7e80`, `Definir ON pôr do sol`, `Definir OFF manual`, `Definir ON manual`.
- **alarme_casa — MINOR CLEANUP:** 7 par(es) praticamente encostado(s); 1 ponto(s) de concentração de wires. Pontos mais carregados: `Avisar a cada — 5 tentativas`, `Identificar falha: armar`, `Identificar falha: desarmar`, `Limite — 0 (sem limite)`.
- **resfriamento_raspberry_pi — NEEDS REORGANIZATION:** 17 par(es) praticamente encostado(s); 1 mudança(s) vertical(is)/zig-zag; 1 branch(es) com destinos desalinhados; 3 cruzamento(s) geométrico(s) possível(is); 1 ponto(s) de concentração de wires. Pontos mais carregados: `Saída: limpar snapshot -> observabilidade`, `Finalizar normalização`, `Saída: remover emergência -> observabilidade`, `Saída: remover falha -> observabilidade`.
- **storage_health — NEEDS REORGANIZATION:** margem esquerda de 54 px; 9 par(es) praticamente encostado(s); 1 gap(s)/wire(s) acima de 500 px; 1 mudança(s) vertical(is)/zig-zag; 2 branch(es) com destinos desalinhados; 6 cruzamento(s) geométrico(s) possível(is); 1 conflito(s) potencial(is) na área de testes. Pontos mais carregados: `Ler storage e categorias no HA`, `Reavaliar após recomposição`, `Validar termino / cooldown`, `Iniciar execução manual`.
- **localizacao_pessoas — NEEDS REORGANIZATION:** 27 par(es) praticamente encostado(s); 2 branch(es) com destinos desalinhados; 1 cruzamento(s) geométrico(s) possível(is); 2 ponto(s) de concentração de wires; 13 conflito(s) potencial(is) na área de testes. Pontos mais carregados: `Iniciar teste pelo coordenador`, `resident_primary 1/3 → not_home`, `resident_primary 2/3 → near_home`, `RETORNO confirmado → publicar chegada v1`.
- **contexto_vehicle_primary — NEEDS REORGANIZATION:** 32 par(es) praticamente encostado(s); 4 branch(es) com destinos desalinhados; 2 cruzamento(s) geométrico(s) possível(is); 8 ponto(s) de concentração de wires; 6 conflito(s) potencial(is) na área de testes. Pontos mais carregados: `Separar releitura de cache real e dry-run`, `Separar refresh real e dry-run`, `test_mode termina em dry-run?`, `vehicle_primary 2/3 → near_home`.
- **iluminacao_seguranca — NEEDS REORGANIZATION:** 8 par(es) praticamente encostado(s); 1 gap(s)/wire(s) acima de 500 px; 2 branch(es) com destinos desalinhados; 5 cruzamento(s) geométrico(s) possível(is); 3 ponto(s) de concentração de wires. Pontos mais carregados: `Ativação atual pertence à automação?`, `Estado decidido → publicação`, `Contextos permitem replay agora?`, `Marcar refletor ativo por chegada`.
- **atualizacoes_diarias — NEEDS REORGANIZATION:** 14 par(es) praticamente encostado(s); 6 branch(es) com destinos desalinhados; 7 cruzamento(s) geométrico(s) possível(is); 2 ponto(s) de concentração de wires; 7 conflito(s) potencial(is) na área de testes. Pontos mais carregados: `Ler resultado npm seguro`, `Ler status final do Codex`, `Ler promoção segura`, `Falha ao ler containers`.
- **guardiao_memoria_host — NEEDS REORGANIZATION:** 10 par(es) praticamente encostado(s); 1 branch(es) com destinos desalinhados; 3 ponto(s) de concentração de wires. Pontos mais carregados: `OBSERVAR: memória saudável`, `AUDITAR: árvore encerrada`, `OBSERVAR: pressão segura`, `FONTE: ler resultado (timeout 15 s)`.
- **contexto_chegadas — NEEDS REORGANIZATION:** 17 par(es) praticamente encostado(s); 9 mudança(s) vertical(is)/zig-zag; 9 branch(es) com destinos desalinhados; 1 cruzamento(s) geométrico(s) possível(is); 2 conflito(s) potencial(is) na área de testes. Pontos mais carregados: `Snapshot foi aceito como atual?`, `Snapshot pertence a pessoas?`, `Posição de origem está ready?`, `Melhor localização confirma alguém fora?`.
- **monitoramento_vpn — NEEDS REORGANIZATION:** 8 par(es) praticamente encostado(s); 1 ponto(s) de concentração de wires; 5 conflito(s) potencial(is) na área de testes. Pontos mais carregados: `TESTE 4: avaliar +121 s`, `TESTE 2B: internet offline`, `TESTE 3: VPN offline`, `TESTE 5: VPN online`.
- **alarme_desarme_chegada — MINOR CLEANUP:** 4 par(es) praticamente encostado(s); 7 branch(es) com destinos desalinhados; 1 conflito(s) potencial(is) na área de testes. Pontos mais carregados: `Contrato é security.arrival.v1?`, `Ciclo externo foi confirmado?`, `Direção é returning?`, `Kind é arrival?`.
- **recuperacao_rtx — NEEDS REORGANIZATION:** 11 par(es) praticamente encostado(s); 3 branch(es) com destinos desalinhados; 7 cruzamento(s) geométrico(s) possível(is); 8 conflito(s) potencial(is) na área de testes. Pontos mais carregados: `Resetar incidente de TESTE`, `Uma notificação por incidente e modo`, `Indisponível em TESTE ou produção?`, `FONTE: computador da RTX está ligado?`.
- **alertas_codex — NEEDS REORGANIZATION:** margem esquerda de 34 px; 15 par(es) praticamente encostado(s); 1 branch(es) com destinos desalinhados; 1 cruzamento(s) geométrico(s) possível(is); 2 ponto(s) de concentração de wires. Pontos mais carregados: `Uso atingiu nível crítico?`, `EFEITO: notificação persistente`, `EFEITO: registrar último alerta`, `EFEITO: registrar horário`.
- **backup_git — NEEDS REORGANIZATION:** margem esquerda de 24 px; 8 par(es) praticamente encostado(s); 1 mudança(s) vertical(is)/zig-zag; 2 cruzamento(s) geométrico(s) possível(is); 4 conflito(s) potencial(is) na área de testes. Pontos mais carregados: `TESTE → terminal dry-run`, `Atualização posterior é TESTE?`, `Worker finalizado`, `TESTE 3B: falha`.
- **monitoramento_internet — NEEDS REORGANIZATION:** margem esquerda de 25 px; 11 par(es) praticamente encostado(s); 1 mudança(s) vertical(is)/zig-zag; 1 branch(es) com destinos desalinhados; 1 cruzamento(s) geométrico(s) possível(is). Pontos mais carregados: `Estado pronto → publicar`, `Atingiu 2 sucessos consecutivos?`, `Entrada é TESTE sintético?`, `Existe política válida?`.
- **monitoramento_zigbee — NEEDS REORGANIZATION:** margem esquerda de 33 px; 6 par(es) praticamente encostado(s); 1 mudança(s) vertical(is)/zig-zag; 3 branch(es) com destinos desalinhados; 4 cruzamento(s) geométrico(s) possível(is); 1 conflito(s) potencial(is) na área de testes. Pontos mais carregados: `Falha fechada sem política`, `Componente ainda está offline?`, `Política de lembrete existe?`, `Existe política válida?`.
- **monitoramento_tuya — NEEDS REORGANIZATION:** margem esquerda de 33 px; 11 par(es) praticamente encostado(s); 1 mudança(s) vertical(is)/zig-zag; 2 ponto(s) de concentração de wires; 1 conflito(s) potencial(is) na área de testes. Pontos mais carregados: `Preparar resultado do dispositivo`, `Persistir estado por dispositivo`, `ADAPTAR: agrupar dispositivos`, `Há dispositivo Tuya monitorável?`.
- **notificacoes_chegadas_residentes — NEEDS REORGANIZATION:** margem esquerda de 24 px; 10 par(es) praticamente encostado(s); 3 branch(es) com destinos desalinhados; 2 ponto(s) de concentração de wires; 1 conflito(s) potencial(is) na área de testes. Pontos mais carregados: `Configuração completa é válida?`, `Quem está chegando?`, `É chegada de pessoa?`, `Validar unidades, limites e relações`.
- **observabilidade_global — NEEDS REORGANIZATION:** 13 par(es) praticamente encostado(s); 3 cruzamento(s) geométrico(s) possível(is); 1 ponto(s) de concentração de wires; 3 conflito(s) potencial(is) na área de testes. Pontos mais carregados: `Separar produção, TESTE real e dry-run`, `Notificar falha interna sem recursão`, `TESTE simulado → terminal dry-run`, `Encerrar wake aceito sem incidente`.
- **Notificar celulares, Echo e Home Assistant — MINOR CLEANUP:** 4 par(es) praticamente encostado(s). Pontos mais carregados: `Anunciar na Echo Dot`, `Push resident_primary`, `Push resident_secondary`, `Remover alerta anterior`.

## Restrições da correção

A reorganização deve preservar integralmente IDs, tipos, tabs, memberships, conexões, links, ordem de execução, regras, mensagens, payloads, JavaScript, entidades, serviços, tópicos e configuração. Somente `x`/`y` dos objetos posicionados e `w`/`h` de `group` podem mudar. Um candidato que não possa ser corrigido apenas com essas propriedades permanece documentado.
