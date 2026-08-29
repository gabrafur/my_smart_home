import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
EXPECTED_NATIVE_AUTOMATIONS = {
    "1783799940000",
    "portao_garagem_rele_preso_em_on",
    "raspberry_pi_health_problem_notification",
    "raspberry_pi_health_recovery_notification",
    "raspberry_pi_home_assistant_started",
}


def automation_ids(path: Path) -> set[str]:
    text = path.read_text(encoding="utf-8")
    if path.name != "automations.yaml":
        match = re.search(r"(?ms)^automation:\s*\n(?P<body>(?:^[ \t].*\n?)*)", text)
        if not match:
            return set()
        text = match.group("body")
    return set(re.findall(r'(?m)^\s*- id:\s*["\']?([^\s"\']+)', text))


class NativeAutomationBoundaryTests(unittest.TestCase):
    def test_only_reviewed_native_automations_exist(self):
        actual = automation_ids(ROOT / "homeassistant" / "automations.yaml")
        for package in (ROOT / "homeassistant" / "packages").glob("*.yaml"):
            actual.update(automation_ids(package))
        self.assertEqual(EXPECTED_NATIVE_AUTOMATIONS, actual)

    def test_garage_watchdog_can_only_open_the_contact(self):
        package = (ROOT / "homeassistant" / "packages" / "portao_garagem.yaml").read_text(
            encoding="utf-8"
        )
        watchdog = package.split("- id: portao_garagem_rele_preso_em_on", 1)[1]
        self.assertIn('for: "00:00:05"', watchdog)
        self.assertIn("action: switch.turn_off", watchdog)
        self.assertNotIn("action: switch.turn_on", watchdog)

    def test_tv_wake_uses_internal_event_and_secret(self):
        automation = (ROOT / "homeassistant" / "automations.yaml").read_text(
            encoding="utf-8"
        )
        self.assertIn("trigger: samsungtv.turn_on", automation)
        self.assertIn("action: wake_on_lan.send_magic_packet", automation)
        self.assertIn("mac: !secret tv_sala_mac", automation)


if __name__ == "__main__":
    unittest.main()
