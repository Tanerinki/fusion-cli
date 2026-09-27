import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * v0.2 — a SYNTHETIC Home Assistant configuration folder (no Git), with deliberate problems and sentinel secrets. The
 * sentinels must never reach a provider: not in a prompt, not in a provider's view. Nothing here is a real credential.
 *
 * Deliberate problems (what an analysis should find):
 *   1. configuration.yaml: `http.use_x_forwarded_for` without `trusted_proxies` (Home Assistant refuses to start the http
 *      integration that way).
 *   2. configuration.yaml: the MQTT password is written inline instead of `!secret` (a plain secret in the config).
 *   3. automations.yaml: an automation targets `light.livingroom_lamp`, the entity is `light.living_room_lamp`.
 *   4. automations.yaml: two automations share the id `motion_hallway`.
 *   5. custom_components/example/manifest.json lacks the required `version` key.
 *   6. scripts.yaml: `service:` where current Home Assistant uses `action:`.
 */
export const HA_SENTINELS = Object.freeze({
  secretsYaml: "HA-SENTINEL-secrets-yaml-5f1e0c",
  storageAuth: "HA-SENTINEL-storage-auth-9c2d44",
  configEntries: "HA-SENTINEL-config-entries-77ab31",
  inlinePassword: "HA-SENTINEL-inline-pw-3b3b90",
  logToken: "HA-SENTINEL-log-bearer-0d0d0d0d0d0d0d0d0d",
  githubToken: `ghp_${"S".repeat(36)}`,
});
export const HA_FILES: Readonly<Record<string, string>> = Object.freeze({
  "configuration.yaml": [
    "homeassistant:",
    "  name: Home",
    "  latitude: !secret home_latitude",
    "  longitude: !secret home_longitude",
    "  unit_system: metric",
    "  time_zone: Europe/Berlin",
    "  packages: !include_dir_named packages",
    "",
    "default_config:",
    "",
    "http:",
    "  use_x_forwarded_for: true",
    "",
    "automation: !include automations.yaml",
    "script: !include scripts.yaml",
    "scene: !include scenes.yaml",
    "",
    "mqtt:",
    "  broker: 192.168.1.10",
    "  username: homeassistant",
    `  password: ${HA_SENTINELS.inlinePassword}`,
    "",
    "recorder:",
    "  purge_keep_days: 10",
    "",
  ].join("\n"),
  "automations.yaml": [
    "- id: motion_hallway",
    "  alias: Hallway light on motion",
    "  trigger:",
    "    - platform: state",
    "      entity_id: binary_sensor.hallway_motion",
    "      to: \"on\"",
    "  action:",
    "    - service: light.turn_on",
    "      target:",
    "        entity_id: light.hallway",
    "- id: motion_hallway",
    "  alias: Living room lamp at sunset",
    "  trigger:",
    "    - platform: sun",
    "      event: sunset",
    "  action:",
    "    - service: light.turn_on",
    "      target:",
    "        entity_id: light.livingroom_lamp",
    "",
  ].join("\n"),
  "scripts.yaml": [
    "movie_mode:",
    "  alias: Movie mode",
    "  sequence:",
    "    - service: light.turn_off",
    "      target:",
    "        entity_id: light.living_room_lamp",
    "",
  ].join("\n"),
  "scenes.yaml": [
    "- id: evening",
    "  name: Evening",
    "  entities:",
    "    light.living_room_lamp:",
    "      state: \"on\"",
    "      brightness: 120",
    "",
  ].join("\n"),
  "packages/heating.yaml": [
    "climate:",
    "  - platform: generic_thermostat",
    "    name: Living room",
    "    heater: switch.living_room_heater",
    "    target_sensor: sensor.living_room_temperature",
    "",
  ].join("\n"),
  "custom_components/example/manifest.json": JSON.stringify({ domain: "example", name: "Example", documentation: "https://example.invalid",
    codeowners: [], requirements: [], iot_class: "local_polling" }, null, 2),
  "custom_components/example/__init__.py": "\"\"\"Example integration.\"\"\"\n\nDOMAIN = \"example\"\n\n\nasync def async_setup(hass, config):\n    return True\n",
  "secrets.yaml": [
    "home_latitude: 52.5200",
    "home_longitude: 13.4050",
    `mqtt_password: ${HA_SENTINELS.secretsYaml}`,
    `github_token: ${HA_SENTINELS.githubToken}`,
    "",
  ].join("\n"),
  ".storage/auth": JSON.stringify({ version: 1, key: "auth", data: { refresh_tokens: [{ id: "r1", token: HA_SENTINELS.storageAuth,
    jwt_key: HA_SENTINELS.storageAuth }] } }, null, 2),
  ".storage/core.config_entries": JSON.stringify({ version: 1, key: "core.config_entries", data: { entries: [{ domain: "mqtt",
    data: { password: HA_SENTINELS.configEntries } }] } }, null, 2),
  "home-assistant.log": `2026-09-01 10:00:00 ERROR (MainThread) [homeassistant.components.http] Invalid config: use_x_forwarded_for without trusted_proxies\n` +
    `2026-09-01 10:00:01 DEBUG (MainThread) [api] request with Authorization: Bearer ${HA_SENTINELS.logToken}\n`,
  ".HA_VERSION": "2026.9.0\n",
});

/** Writes the fixture into `dir/<name>` (a plain folder: no Git) and returns its path. */
export async function createHomeAssistantFixture(dir: string, name = "homeassistant"): Promise<string> {
  const root = join(dir, name);
  for (const [path, content] of Object.entries(HA_FILES)) {
    await mkdir(dirname(join(root, ...path.split("/"))), { recursive: true });
    await writeFile(join(root, ...path.split("/")), content);
  }
  // A recorder database: binary, withheld.
  await writeFile(join(root, "home-assistant_v2.db"), Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x00, 0x01, 0x02]));
  return root;
}
