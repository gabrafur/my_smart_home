# Iluminacao de seguranca (Node-RED)

Flow `iluminacao_seguranca` (`nodered/flows.json`, tab `2fd40fd570e6f37a`).

## Objetivo

Ligar o `switch.refletor_portao_carros` quando Gabriel, Valeria ou o Creta
chegam em casa durante a noite, dando visibilidade contra possiveis
invasores proximos ao portao/garagem.

## Entidades usadas

- `device_tracker.iphone_de_gabriel_furlan`
- `device_tracker.iphone_de_valeria`
- `device_tracker.creta_location` (integracao `kia_uvo`)
- `binary_sensor.creta_engine`
- `lock.creta_door_lock`
- `sun.sun`
- `switch.refletor_portao_carros`
- `button.creta_force_refresh`

## Logica de chegada

1. Mudancas de localizacao (iPhones, Creta), sol e trava do Creta alimentam
   `sec_prepare_arrival_context`, que calcula distancia ate
   `HOME_LAT`/`HOME_LON` para cada entidade rastreada.
2. Gabriel, Valeria e Creta "armam" (`armed[nome] = true`) quando ficam a
   mais de 100 m de casa (`ARM_DISTANCE_M`).
3. A "chegada" e detectada quando uma entidade armada volta para ate
   **300 m** de casa (`ARRIVAL_DISTANCE_M`, node
   `sec_detect_arriving_source`). Esse mesmo valor de 300 m e usado para
   `creta_home` (`sec_prepare_arrival_context`) e para limpar o armamento por
   contexto (`sec_update_arming_context`) — os tres precisam ficar
   sincronizados.
4. Se a chegada for do Creta, o refletor liga direto (dado que a chegada
   ja e do proprio carro).
5. Se a chegada for de pessoa (Gabriel/Valeria), so liga se
   `binary_sensor.creta_engine` estiver `on`, ou, como fallback (atraso da
   integracao Kia), se o Creta estava armado como fora e ja aparece a ate
   700 m de casa (`CRETA_APPROACH_DISTANCE_M`).
6. So liga se estiver escuro (`sun.sun` = `below_horizon`) e se o refletor
   ainda nao estiver ativo por chegada (evita re-disparo).
7. Desliga sozinho apos 10 minutos, ou imediatamente quando o Creta e
   confirmado em casa (`creta_home`), desliga o motor ou tranca a porta
   estando em casa.

## Atualizacao de localizacao (refresh)

Node `sec_refresh_every_10min` (inject, apesar do nome roda a cada 1 min)
dispara `sec_refresh_anyone_away` a cada ciclo:

- Enquanto alguem estiver fora, pede `request_location_update` para os
  iPhones **a cada 1 min** (barato, sem rate limit conhecido).
- O refresh forcado do Creta (`button.creta_force_refresh` +
  `homeassistant.update_entity`) roda **a cada 5 min** por padrao, mas passa
  a rodar **a cada 1 min** quando o proprio Creta esta a menos de 1500 m de
  casa (`KIA_NEARBY_DISTANCE_M`). Isso existe porque a integracao `kia_uvo`
  tem lag e rate limit da API da Kia/Hyundai — forcar refresh com frequencia
  alta o tempo todo arrisca bloqueio temporario da conta e drena a bateria de
  12V do carro. A aceleracao so perto de casa concentra o refresh extra
  exatamente na janela em que a deteccao de chegada precisa de dado fresco.

## Historico relevante

- Commit `2026-07`: raio de chegada ampliado de 50 m para 300 m (GPS do
  iPhone/Kia nao era preciso o suficiente para confirmar chegada a 50 m de
  forma confiavel) — alinhado nos tres pontos que usavam esse valor, e no
  texto do comentario `sec_comment_arrival_light`.
- Mesma leva: refresh de localizacao acelerado (1 min para iPhones sempre
  que alguem esta fora; 1 min para o Creta so quando ele esta perto de
  casa) para reduzir a lentidao entre o carro chegar e o refletor acender.

## Manutencao

Sempre que este flow for alterado (limiares de distancia, cadencia de
refresh, entidades envolvidas), atualizar esta doc na mesma mudanca.
