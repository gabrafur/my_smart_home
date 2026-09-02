#!/usr/bin/env python3
"""Regression checks for the parked-location wording in the vehicle dashboard."""

from pathlib import Path
import unittest


DASHBOARD = (
    Path(__file__).resolve().parents[1] / "dashboards" / "vehicle_primary.yaml"
)
CONTROLS = (
    Path(__file__).resolve().parents[1] / "packages" / "vehicle_primary_controls.yaml"
)


def main() -> None:
    dashboard = DASHBOARD.read_text(encoding="utf-8")
    controls = CONTROLS.read_text(encoding="utf-8")

    assert "heading: Último estacionamento e viagens" in dashboard
    assert "o mapa mostra o último estacionamento confirmado" in dashboard
    assert "não fornece a posição enquanto o veículo está em movimento" in dashboard
    assert "entity: device_tracker.vehicle_primary" in dashboard
    assert "name: Posição confirmada em" not in dashboard
    assert "sensor.vehicle_primary_current_location_since" in dashboard
    assert "sensor.vehicle_primary_location_last_updated" not in dashboard
    assert "tracker.last_changed" in dashboard
    assert "persistent_since_ts if persistent_since_ts else tracker_since_ts" in dashboard
    assert "nesta localização desde" in dashboard
    assert "O horário permanece fixo enquanto a localização não mudar" not in dashboard
    assert "última posição estacionada recebida há" not in dashboard
    assert "binary_sensor.vehicle_primary_engine" in dashboard
    assert "**Atualização dos dados**" in dashboard
    assert "nova verificação em cerca de" in dashboard
    assert "verificando agora o cache do servidor antes de outro wake" in dashboard
    assert "Atualização do veículo ainda não concluída" in dashboard
    assert "Integração Bluelink ainda indisponível" in dashboard
    assert "A última atualização do veículo falhou" in dashboard
    assert "refresh_failure_endpoint" in dashboard
    assert "failure_labels" in dashboard
    assert "nova tentativa automática em cerca de" in dashboard
    assert "nova tentativa automática agora" in dashboard
    assert "sensor.vehicle_primary_api_retry_at" in dashboard
    assert "api_status == 'rate_limited'" in dashboard
    assert "API liberada para nova tentativa em cerca de" in dashboard
    assert "API liberada para nova tentativa agora" in dashboard
    assert "nenhuma consulta ao servidor está em andamento" not in dashboard
    assert "refresh_failure == 'api_error' and cache_age_s is none" in dashboard
    refresh_failure_definition = (
        "{% set refresh_failure = state_attr("
        "'sensor.vehicle_primary_refresh_coordinator', 'last_failure_class') %}"
    )
    assert dashboard.count(refresh_failure_definition) == 1
    assert dashboard.index(refresh_failure_definition) < dashboard.index(
        "refresh_failure == 'integration_unavailable'"
    )
    assert dashboard.index("refresh_failure == 'integration_unavailable'") < dashboard.index(
        "Último wake confirmado, solicitado há cerca de"
    )
    assert dashboard.index("refresh_failure_label is not none") < dashboard.index(
        "Último wake confirmado, solicitado há cerca de"
    )
    assert dashboard.index("refresh_failure_label is not none") < dashboard.index(
        "Wake periódico pausado até 06h"
    )
    assert "<ha-alert" not in dashboard
    assert "🟢" in dashboard
    assert "🔵" in dashboard
    assert "🟡" in dashboard
    assert "🔴" in dashboard
    assert "Pausa noturna programada" in dashboard
    assert "command == 'cooldown'" in dashboard
    assert "command in ['failed', 'cooldown']" not in dashboard
    assert "O último comando falhou ou ainda está em cooldown" not in dashboard
    assert "Servidor consultado há" in dashboard
    assert "esta consulta não acorda o carro" in dashboard
    assert "o esperado é uma consulta a cada 15 min" in dashboard
    assert "request_age_s = ([0, as_timestamp(now()) - request_ts] | max)" in dashboard
    assert "request_age_min = (request_age_s / 60) | round(0)" in dashboard
    assert "Último wake confirmado, solicitado há cerca de {{ format_number_ptbr(request_age_min) }} min" in dashboard
    assert "dados passivos do servidor podem confirmar um estacionamento mais recente sem novo wake" in dashboard
    assert "success_ts - request_ts <= 1260" in dashboard
    assert "Ainda sem confirmação causal do último wake" in dashboard
    assert "O último wake ainda não produziu dados novos" not in dashboard
    assert "'interval_minutes') | int(0)" in dashboard
    assert "ignora o prazo periódico e a pausa noturna" not in dashboard
    assert "Cache consultado em" in dashboard
    assert "Consulta executada em" not in dashboard
    assert "consultado a cada **15 minutos** sem acordar o carro" in dashboard
    assert "backoff progressivo de até **6 horas**" in dashboard
    assert "O botão **Atualizar agora** força um wake" in dashboard
    assert "**Último comando remoto**" in dashboard
    assert "name: Localizar (segure)" in dashboard
    assert "name: Travar portas" in dashboard
    assert dashboard.count("action: lock") == 2
    assert "name: Destravar portas" in dashboard
    assert dashboard.count("action: unlock") == 2
    assert dashboard.count("entity: sensor.vehicle_primary_car_battery_level") == 1
    assert "name: Bateria 12 V" in dashboard
    assert "perform_action: lock.lock" not in dashboard
    assert "perform_action: lock.unlock" not in dashboard
    assert "text: Travar as portas do Creta remotamente?" in dashboard
    assert "O Bluelink não fornece litros consumidos por viagem" in dashboard
    assert "trip.estimated_km_per_l" in dashboard
    assert "referência da janela" not in dashboard
    assert "Consumo sem amostras suficientes" not in dashboard
    assert dashboard.index("**Último comando remoto**") < dashboard.index(
        "**Atualização dos dados**"
    )
    assert "unique_id: vehicle_primary_current_location_since" in controls
    assert "current_state == 'not_home'" in controls
    assert "previous_state != current_state or moved_outside_zone" in controls
    assert "movement_threshold_m: 250" in controls
    assert "event_type: kia_uvo_api_retry" in controls
    assert "unique_id: vehicle_primary_api_retry_at" in controls

    print("vehicle_primary dashboard: 59 verificações aprovadas.")


class VehiclePrimaryDashboardLocationTest(unittest.TestCase):
    def test_location_wording_and_controls(self):
        main()


if __name__ == "__main__":
    unittest.main()
