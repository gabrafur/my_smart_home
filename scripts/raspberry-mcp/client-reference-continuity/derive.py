"""Pure derivation: keep component units that run the continuity entry when the client re-pins references.

The client lifecycle moves the component policy (worker and repair-policy leaves) and
re-pins the policy hash in the job, validate and guard unit ``root_bootstrap.py`` lines.
With the continuity runtime installed, job and validate run
``continuity_entry.py <anchor> worker %i`` / ``validate %i`` instead. The anchor pins
the policy scope without the two client leaves, so those units stay valid across a
client cutover. ``ClientReferenceClosure.plan`` refused them (``reference_unit_foreign``)
and would have blocked every later client install or rollback.

Now job/validate in exactly that continuity form (one matching ExecStart line, no
legacy policy pin) are kept byte for byte; every other unit shape is refused as before,
and guard keeps the legacy re-pin. Pins of native_binding.py move as in
client-rollback-completion/derive.py.
"""
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    'rollback_completion_derive', Path(__file__).resolve().parent.parent / 'client-rollback-completion' / 'derive.py')
_base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_base)
NAMES = _base.NAMES
need, swap = _base.need, _base.swap

OLD = ("   text=raw[key].decode();need(sum(x==line for x in text.splitlines())==1 and text.count(before)==1,'reference_unit_foreign')\n")
NEW = ("   text=raw[key].decode()\n"
       "   continuity=re.compile(r'ExecStart=/usr/bin/python3 -I -S -B /usr/local/lib/raspberry-component-repair/continuity_entry\\.py [a-f0-9]{64} '+re.escape(verb))\n"
       "   if key in('job','validate')and sum(bool(continuity.fullmatch(x))for x in text.splitlines())==1 and line not in text.splitlines()and before not in text:\n"
       "    # Continuity anchor pins the policy scope without the client leaves; keep the unit.\n"
       "    result[key]=raw[key];continue\n"
       "   need(sum(x==line for x in text.splitlines())==1 and text.count(before)==1,'reference_unit_foreign')\n")


def patch(source):
    need(b'Continuity anchor pins the policy scope' not in source, 'native_binding_already_continuity_aware')
    return swap(source, OLD.encode(), NEW.encode(), 'reference_unit_anchor')


def derive(before):
    need(type(before) is dict and set(before) == set(NAMES) and all(type(v) is bytes for v in before.values()), 'six_inputs')
    return _base.repin(before, 'native_binding', patch(before['native_binding']))
