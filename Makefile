# CC-Monitor 是纯 Python 实现，没有编译步骤——这个 Makefile 只负责"装到系统里"：
# 把 cc_monitor/ 包 + bin/ 脚本 + install.py 拷到 PREFIX 下，再在 PREFIX/bin 里建好命令行链接。
# 是否要把 hooks 注册进 Claude Code 的 settings.json 是另一件事，见 `make install` 打印的提示，
# 不在这里自动做——那是会改用户个人配置文件的操作，应该让用户自己明确执行。
PREFIX ?= /usr/local
LIBDIR := $(PREFIX)/lib/cc-monitor
BINDIR := $(PREFIX)/bin
PY ?= python3

.PHONY: install uninstall

install:
	install -d "$(LIBDIR)" "$(BINDIR)"
	cp -a cc_monitor "$(LIBDIR)/"
	cp -a bin "$(LIBDIR)/"
	cp -a install.py "$(LIBDIR)/"
	chmod +x "$(LIBDIR)"/bin/*
	ln -sf "$(LIBDIR)/bin/CC-Monitor" "$(BINDIR)/CC-Monitor"
	ln -sf "$(LIBDIR)/bin/CC-Monitor-hook" "$(BINDIR)/CC-Monitor-hook"
	ln -sf "$(LIBDIR)/bin/CC-Monitor-probe" "$(BINDIR)/CC-Monitor-probe"
	@echo ""
	@echo "已安装到 $(LIBDIR)，命令行工具已链接到 $(BINDIR)（CC-Monitor / CC-Monitor-hook / CC-Monitor-probe）。"
	@echo ""
	@echo "还差最后一步——把 hooks 注册进 Claude Code 的 settings.json（这一步不会自动做）："
	@echo "  $(PY) $(LIBDIR)/install.py                          # 全局安装：写入 ~/.claude/settings.json"
	@echo "  $(PY) $(LIBDIR)/install.py --project /path/to/proj  # 只对某个项目生效"

uninstall:
	rm -f "$(BINDIR)/CC-Monitor" "$(BINDIR)/CC-Monitor-hook" "$(BINDIR)/CC-Monitor-probe"
	rm -rf "$(LIBDIR)"
	@echo "已删除 $(LIBDIR) 和 $(BINDIR) 下的命令行链接。"
	@echo "注意：~/.claude/settings.json 里已经注册的 hooks 条目不会自动清理，需要手动编辑删除。"
