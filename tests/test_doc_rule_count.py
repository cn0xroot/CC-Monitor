"""文档里写的规则条数必须跟 default_rules.json 的实际条数一致。

这个数字很容易忘：本次会话里它就过时了两次（74 -> 78 -> 86），每次加规则都要改
README 中英两份 + 官网中英两页共 6 处。忘了的后果不是报错，是文档静悄悄地说谎。
这条测试让它变成一个会失败的断言。

历史 CHANGELOG 条目不在检查范围内——那些是发布记录，"规则数从 70 增至 74"描述的
是当时的事实，不该跟着现在的条数改。

直接跑：python3 -m unittest tests/test_doc_rule_count.py
"""
import io
import json
import os
import re
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def rule_count():
    with io.open(os.path.join(REPO, "cc_monitor", "default_rules.json"), encoding="utf-8") as f:
        return len(json.load(f))


# 文件 -> 该文件里声明总条数的写法。官网两页不在 git 里（HTML/ 被 .gitignore 排除），
# 存在才检查，不存在就跳过，免得只 clone 仓库的人跑不过测试。
DOC_PATTERNS = {
    "README.zh-CN.md": [r"\*\*(\d+) 条内置检测规则"],
    "README.md": [r"\*\*(\d+) built-in detection rules"],
    "HTML/index.html": [r"<h2>(\d+) 条默认规则", r"(\d+) 条规则每条自带"],
    "HTML/index.en.html": [r"<h2>(\d+) default rules", r"All (\d+) rules carry"],
}


class TestDocumentedRuleCount(unittest.TestCase):
    def test_docs_match_actual_rule_count(self):
        actual = rule_count()
        checked = 0
        for rel, patterns in DOC_PATTERNS.items():
            path = os.path.join(REPO, rel)
            if not os.path.exists(path):
                continue  # 官网目录不入库，允许缺失
            text = io.open(path, encoding="utf-8").read()
            for pat in patterns:
                m = re.search(pat, text)
                self.assertIsNotNone(m, f"{rel} 里找不到规则条数的写法：{pat}")
                self.assertEqual(
                    int(m.group(1)), actual,
                    f"{rel} 写的是 {m.group(1)} 条，default_rules.json 实际 {actual} 条",
                )
                checked += 1
        self.assertGreater(checked, 0, "一处都没检查到，说明匹配写法失效了")

    def test_rule_ids_are_unique(self):
        with io.open(os.path.join(REPO, "cc_monitor", "default_rules.json"), encoding="utf-8") as f:
            rules = json.load(f)
        ids = [r["id"] for r in rules]
        dupes = {i for i in ids if ids.count(i) > 1}
        self.assertEqual(dupes, set(), f"规则 id 重复：{dupes}")


if __name__ == "__main__":
    unittest.main()
