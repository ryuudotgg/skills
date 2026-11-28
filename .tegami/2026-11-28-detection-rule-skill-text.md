---
packages:
  skills-cli: patch
---

### 🎨 Agents bind a checkout after asking for its project

The plans skill now states the four steps project detection takes, and once you name the project for a checkout no step resolved, the agent runs `skills plans bind` there so later sessions resolve it.
