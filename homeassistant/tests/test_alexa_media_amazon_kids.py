"""Regression tests for the locally patched Alexa Media Player release."""

from pathlib import Path
import re
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
ALEXA_MEDIA_ROOT = REPOSITORY_ROOT / "homeassistant/custom_components/alexa_media"


class AlexaMediaAmazonKidsRegressionTest(unittest.TestCase):
    """Keep independently polled Amazon Kids sensors out of coordinator data."""

    def test_coordinator_filters_binary_sensors_without_alexa_entity_id(self) -> None:
        source = (ALEXA_MEDIA_ROOT / "__init__.py").read_text(encoding="utf-8")

        self.assertIn(
            'alexa_entity_id = getattr(binary_sensor, "alexa_entity_id", None)',
            source,
        )
        self.assertRegex(
            source,
            re.compile(
                r"if (?:binary_sensor\.enabled and alexa_entity_id|"
                r"alexa_entity_id and binary_sensor\.enabled):\s*"
                r"entities_to_monitor\.add\(alexa_entity_id\)"
            ),
        )
        self.assertNotIn(
            "entities_to_monitor.add(binary_sensor.alexa_entity_id)", source
        )

    def test_amazon_kids_sensor_remains_independently_polled(self) -> None:
        source = (ALEXA_MEDIA_ROOT / "binary_sensor.py").read_text(encoding="utf-8")

        self.assertIn("class AmazonKidsSensor(BinarySensorEntity):", source)
        self.assertIn("await AlexaAPI.get_child_mode(", source)
        self.assertNotIn("class AmazonKidsSensor(CoordinatorEntity", source)


if __name__ == "__main__":
    unittest.main()
