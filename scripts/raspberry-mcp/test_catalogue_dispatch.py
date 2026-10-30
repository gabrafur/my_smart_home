"""Evaluate only the broker's catalogue expression, without loading runtime."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest


class CatalogueDispatchTests(unittest.TestCase):
    def test_policy_sees_every_already_registered_dispatch_group(self):
        source = (Path(__file__).parent / 'runtime-source/repair-control/repair-broker.py').read_text()
        tree = ast.parse(source)
        assignments = [node for node in ast.walk(tree)
            if isinstance(node, ast.Assign) and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Subscript)
            and isinstance(node.targets[0].value, ast.Name)
            and node.targets[0].value.id == 'data'
            and isinstance(node.targets[0].slice, ast.Constant)
            and node.targets[0].slice.value == 'tool_names']
        self.assertEqual(len(assignments), 1)
        expression = ast.fix_missing_locations(ast.Expression(assignments[0].value))
        base = ['service_health', 'maintenance_capabilities']
        repair = ['codex_repair_capabilities', 'service_health']
        task = ['codex_task_create', 'codex_task_send', 'codex_task_reconcile']
        admin = ['admin_action_apply', 'admin_action_status']
        result = eval(compile(expression, '<catalogue-expression>', 'eval'),
            {'__builtins__': {}, 'list': list, 'dict': dict},
            {'data': {'tool_names': base}, 'repairs': SimpleNamespace(TOOLS=repair),
             'tasks': SimpleNamespace(TOOLS=task),
             'legacy': SimpleNamespace(legacy=SimpleNamespace(client=SimpleNamespace(TOOLS=admin)))})
        self.assertEqual(result, list(dict.fromkeys(base + repair + task + admin)))


if __name__ == '__main__':
    unittest.main()
