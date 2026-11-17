---
packages:
  skills-cli: patch
---

### 🐛 Commit guard judges the push git will really run

The commit guard now counts `git --config-env alias.<name>=<envvar>` as a push in both modes, also nested or hard to parse, and refuses a typed push whose refspec the shell could rewrite, such as an unquoted `{main,topic}` or `#x`. Where `push.default` is `upstream` or `tracking`, the plain `git push origin <branch>` is refused with a block naming the `refs/heads/<branch>:refs/heads/<branch>` form, which still passes.
