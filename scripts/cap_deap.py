"""
cap_deap.py — mitmproxy 抓包脚本：捕获钉钉悟空发往 deap 网关的请求，提取 Bearer Key。

这是 SKILL 文档《docs/CAPTURE_DEAP_KEY.md》里引用的固定脚本，由 SKILL 步骤②使用。
不要在此文件里硬编码任何密钥；它只负责「读请求头 → 写日志」。

用法：
    mitmdump -p 8888 -s scripts/cap_deap.py
日志输出：
    /tmp/deap_capture.log  （含完整请求头，含明文 Authorization，属敏感文件，用完即焚）
"""

from mitmproxy import http
import datetime

LOG = "/tmp/deap_capture.log"


def log(s: str) -> None:
    with open(LOG, "a") as f:
        f.write(f"[{datetime.datetime.now().isoformat()}] {s}\n")


def request(flow: http.HTTPFlow) -> None:
    host = flow.request.pretty_host
    path = flow.request.path
    # 只关心 deap 网关的 chat/completions（key 就挂在这类请求的 Authorization 头上）
    if "api-deap" in host or ("dingtalk" in host and "chat" in path):
        log("=== REQUEST ===")
        log(f"URL: {flow.request.pretty_url}")
        log(f"Authorization: {flow.request.headers.get('Authorization', '')}")
        for k, v in flow.request.headers.items():
            log(f"H {k}: {v}")
        log(f"BODY: {(flow.request.get_text() or '')[:2000]}")


def response(flow: http.HTTPFlow) -> None:
    if "api-deap" in flow.request.pretty_host:
        log("=== RESPONSE ===")
        log(f"status: {flow.response.status_code}")
        # 响应头里的组织/用户信息（x-dingtalk-corp-id / x-dingtalk-org-name 等）
        for k, v in flow.response.headers.items():
            log(f"RH {k}: {v}")
        log(f"BODY: {(flow.response.get_text() or '')[:2000]}")
