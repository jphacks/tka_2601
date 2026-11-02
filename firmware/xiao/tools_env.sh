# Sourced by run.sh and tests/qemu.sh: finds arduino-cli and the ESP32 core on any developer's machine.
core_version=3.3.8
core_index=https://espressif.github.io/arduino-esp32/package_esp32_index.json
if [ -n "${ARDUINO_CLI:-}" ]; then
  cli="$ARDUINO_CLI"
elif command -v arduino-cli >/dev/null; then
  cli=arduino-cli
elif [ -x "/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli" ]; then
  cli="/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli"
else
  echo "arduino-cli が見つかりません。macOS は brew install arduino-cli、ほかは https://arduino.github.io/arduino-cli/latest/installation/ から入れてください。" >&2
  exit 1
fi
config_args=()
config="${ARDUINO_CONFIG:-$HOME/.arduinoIDE/arduino-cli.yaml}"
if [ -f "$config" ]; then config_args=(--config-file "$config"); fi

ensure_core() {
  local installed
  installed="$("$cli" "${config_args[@]+"${config_args[@]}"}" core list | awk '$1 == "esp32:esp32" { print $2 }')"
  if [ -z "$installed" ]; then
    echo "ESP32 コア $core_version を入れます（初回だけ。数 GB あります）。"
    "$cli" "${config_args[@]+"${config_args[@]}"}" core update-index --additional-urls "$core_index"
    "$cli" "${config_args[@]+"${config_args[@]}"}" core install "esp32:esp32@$core_version" --additional-urls "$core_index"
  elif [ "$installed" != "$core_version" ]; then
    echo "注意: ESP32 コアは $installed です。動作を確かめたのは $core_version です。" >&2
  fi
}
