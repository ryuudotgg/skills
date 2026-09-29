# Codex arms

| tier  | `-m`      | effort   | use   |
| ----- | --------- | -------- | ----- |
| small | `model-a` | `low`    | small |
| mid   | `model-b` | `medium` | mid   |
| big   | `model-b` | `high`   | big   |

```
codex -C /tmp review --disable fast_mode -c model="model-c" -c model_reasoning_effort="high" --uncommitted
```
