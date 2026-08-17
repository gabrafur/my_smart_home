#!/usr/bin/env python3
"""Regression checks for the parked-location wording in the vehicle dashboard."""

from pathlib import Path
import unittest


DASHBOARD = (
    Path(__file__).resolve().parents[1] / "dashboards" / "vehicle_primary.yaml"
)


def main() -> None:
    dashboard = DASHBOARD.read_text(encoding="utf-8")

    assert "heading: Último estacionamento e viagens" in dashboard
    assert "O mapa mostra o **último estacionamento confirmado**" in dashboard
    assert "não fornece a posição enquanto o veículo está em movimento" in dashboard
    assert "name: Último estacionamento confirmado" in dashboard
    assert "name: Posição confirmada em" not in dashboard
    assert "sensor.vehicle_primary_location_last_updated" in dashboard
    assert "binary_sensor.vehicle_primary_engine" in dashboard
    assert "**Atualização dos dados**" in dashboard
    assert "Nova tentativa automática em" in dashboard
    assert "**Localizar por luz e buzina**" in dashboard
    assert "name: Localizar (segure)" in dashboard
    assert "name: Travar portas" in dashboard
    assert dashboard.count("action: lock") == 2
    assert "perform_action: lock.lock" not in dashboard
    assert "text: Travar as portas do Creta remotamente?" in dashboard
    assert dashboard.index("**Localizar por luz e buzina**") < dashboard.index(
        "**Atualização dos dados**"
    )

    print("vehicle_primary dashboard: 16 verificações aprovadas.")


class VehiclePrimaryDashboardLocationTest(unittest.TestCase):
    def test_location_wording_and_controls(self):
        main()


if __name__ == "__main__":
    unittest.main()
