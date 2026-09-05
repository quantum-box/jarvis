"""Apply JARVIS permissions after `tauri android init`."""

from pathlib import Path
import xml.etree.ElementTree as ET

manifest = Path(__file__).resolve().parents[1] / "src-tauri/gen/android/app/src/main/AndroidManifest.xml"
android = "http://schemas.android.com/apk/res/android"
ET.register_namespace("android", android)
tree = ET.parse(manifest)
root = tree.getroot()
permission = "android.permission.RECORD_AUDIO"
if not any(node.get(f"{{{android}}}name") == permission for node in root.findall("uses-permission")):
    root.insert(0, ET.Element("uses-permission", {f"{{{android}}}name": permission}))
tree.write(manifest, encoding="utf-8", xml_declaration=True)
