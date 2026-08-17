from __future__ import annotations

import sys

from zip_translator.app import run


def run_embedded_bridge_self_test() -> None:
    from zip_translator.bridge_client import default_bridge_url
    from zip_translator.bridge_process import IntegratedBridge, load_or_create_integrated_token

    manager = IntegratedBridge()
    try:
        runtime = manager.ensure_running(default_bridge_url(), load_or_create_integrated_token())
        if not runtime.owned:
            raise RuntimeError("자체 진단 포트에서 외부 브리지가 감지되었습니다.")
    finally:
        manager.stop()


if __name__ == "__main__":
    if "--embedded-bridge-self-test" in sys.argv:
        run_embedded_bridge_self_test()
    else:
        run()
