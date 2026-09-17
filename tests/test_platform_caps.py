"""平台能力差异的回归测试。

两件事必须成立：
1. macOS 上 `CC-Monitor verify` 不能输出"未发现可疑记录"这类绿色结论——那项检查在
   macOS 上根本没运行（探针用 nettop，看不到 execve），说"通过"是假安全感。
2. Linux 探针的 bpftrace 脚本必须同时处理 AF_INET 和 AF_INET6，否则开了 IPv6 的机器上
   会有静默的网络观测盲区。

直接跑：python3 -m unittest tests/test_platform_caps.py
"""
import io
import os
import re
import sys
import tempfile
import unittest
from unittest import mock

_TMP = tempfile.mkdtemp(prefix="cc-monitor-test-")
os.environ["CC_MONITOR_HOME"] = _TMP
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _REPO)

from cc_monitor import cli  # noqa: E402

BT_PATH = os.path.join(_REPO, "cc_monitor", "probe_linux.bt")


class Args:
    limit = 100


def run_verify_on(system_name):
    buf = io.StringIO()
    with mock.patch("cc_monitor.cli.platform.system", return_value=system_name), \
         mock.patch("sys.stdout", buf):
        cli.cmd_verify(Args())
    return buf.getvalue()


class TestVerifyPlatformHonesty(unittest.TestCase):
    def test_macos_does_not_claim_a_clean_result(self):
        out = run_verify_on("Darwin")
        self.assertIn("不支持执行层交叉验证", out)
        # 最关键的一条：绝不能出现"未发现可疑记录"，那是 Linux 才有资格说的话。
        self.assertNotIn("未发现可疑记录", out)

    def test_macos_explains_what_still_works(self):
        out = run_verify_on("Darwin")
        self.assertIn("hook", out.lower())

    def test_linux_still_reports_normally(self):
        out = run_verify_on("Linux")
        self.assertNotIn("不支持执行层交叉验证", out)
        self.assertIn("未发现可疑记录", out)


class TestProbeCoversIPv6(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bt = io.open(BT_PATH, encoding="utf-8").read()

    def test_connect_handles_both_address_families(self):
        """AF_INET=2 和 AF_INET6=10 两族都要有分支。"""
        self.assertIn("sa_family == 2", self.bt)
        self.assertIn("sa_family == 10", self.bt)

    def test_connect_formats_the_v6_address(self):
        """v6 地址是 16 字节数组，必须走 sockaddr_in6 取址，不能拿 v4 的 s_addr 凑。"""
        self.assertIn("sockaddr_in6", self.bt)
        self.assertIn("sin6_addr", self.bt)
        self.assertIn("sin6_port", self.bt)

    def test_byte_counters_use_the_v6_destination(self):
        """IPv6 socket 上 skc_daddr 是 0，流量必须从 skc_v6_daddr 取目的地址，
        否则 v6 的收发字节会全部堆到 0.0.0.0 这个假地址上。"""
        self.assertIn("skc_v6_daddr", self.bt)
        self.assertEqual(
            self.bt.count("skc_family == 10"), 2,
            "tcp_sendmsg 和 tcp_cleanup_rbuf 两个探点都要覆盖 IPv6",
        )

    def test_v6_output_still_matches_the_bytes_map_parser(self):
        """探针输出的聚合 map 行要能被 probe.py 的正则认出来——IPv6 地址里有冒号，
        得确认解析器不会被冒号绊倒。"""
        from cc_monitor.probe import _BYTES_MAP_LINE

        m = _BYTES_MAP_LINE.match("@tx_bytes[2606:4700:4700::1111, 443]: 725")
        self.assertIsNotNone(m, "IPv6 地址的流量统计行必须能被解析")
        self.assertEqual(m.group(2), "2606:4700:4700::1111")
        self.assertEqual(m.group(3), "443")
        self.assertEqual(m.group(4), "725")


if __name__ == "__main__":
    unittest.main()
