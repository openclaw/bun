"""Bind application variant selection to the existing execution identity."""
VARIANTS = ('js', 'c2-off', 'ts')
SELECTIONS = {'all': VARIANTS, 'js-c2': ('js', 'c2-off'), 'ts': ('ts',)}


def select_variants(name):
    assert isinstance(name, str) and name in SELECTIONS, 'Unknown application variant selection'
    return {'variantSelection': name, 'requestedVariants': list(SELECTIONS[name])}


def requested_variants(execution):
    selected = select_variants(execution['variantSelection'])
    assert execution['requestedVariants'] == selected['requestedVariants'], 'Application variant selection differs from execution identity'
    return selected['requestedVariants']
