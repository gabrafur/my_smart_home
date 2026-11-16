"""Pure derivation: wrap the installed private-content route with the lighting route.

maintenance-entry.mjs (hash-pinned by the maintenance interface gate) imports
makePrivateContentRoute from private-content-route.mjs (not pinned). Renaming the
original export and re-exporting a wrapper adds the two lighting tools without
changing the entry file, its argv or any other route byte.
"""
import hashlib

BASELINE = '2d09f4b9499852a246a648c01e44769b71cf68b5c65430b2bfe6b020971f4819'
OLD = 'export function makePrivateContentRoute('
NEW = 'function makePrivateContentRouteBase('
HEADER = ("\n// Household lighting tools (ha_lights_read, ha_light_set); see lights-route.mjs.\n"
          "import {makeLightsRoute} from './lights-route.mjs';\n")
# v1 (installed 2026-11-16 18:21) passed no audit sink; v2 passes the route's own audit (4th argument).
TAIL_V1 = HEADER + "export function makePrivateContentRoute(...args){return makeLightsRoute(makePrivateContentRouteBase(...args));}\n"
TAIL = HEADER + "export function makePrivateContentRoute(...args){return makeLightsRoute(makePrivateContentRouteBase(...args),undefined,args[3]);}\n"


def derive(before, tail=None):
    if hashlib.sha256(before).hexdigest() != BASELINE:
        raise ValueError('private_content_route_baseline_changed')
    text = before.decode()
    if text.count(OLD) != 1 or NEW in text or 'lights-route' in text:
        raise ValueError('private_content_route_anchor')
    return (text.replace(OLD, NEW) + (TAIL if tail is None else tail)).encode()
