"""Pure fixed-disk I/O profile; never execute QEMU or grant access.

Trusted launchers must seal this module and retain their independent native
resource, process, mount and identity verification. Two precreated workers
bound disk worker stacks without relaxing the existing sandbox or limits.
"""
SANDBOX = 'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny'
ORIGINAL = ('-drive', 'if=none,file=/disk/data.raw,format=raw,id=finite_disk',
            '-device', 'virtio-blk-pci,drive=finite_disk')
BOUNDED = ('-object', 'iothread,id=bounded_disk_io,thread-pool-min=2,thread-pool-max=2',
           '-drive', ORIGINAL[1], '-device', ORIGINAL[3]+',iothread=bounded_disk_io')


def bounded_disk_io(arguments):
    """Change exactly one known disk slot, preserving every other argument."""
    if (type(arguments) is not list or len(arguments) > 256
            or any(type(v) is not str or len(v) > 4096 for v in arguments)):
        raise ValueError('invalid_fixed_VM_arguments')
    sandbox = [i for i, value in enumerate(arguments) if value == '-sandbox']
    if len(sandbox) != 1 or arguments[sandbox[0]:sandbox[0]+2] != ['-sandbox', SANDBOX]:
        raise ValueError('existing_VM_sandbox_changed')
    if any('bounded_disk_io' in value or value.startswith('iothread,') for value in arguments):
        raise ValueError('preexisting_disk_thread_pool_requires_review')
    slots = [i for i in range(len(arguments)-3) if tuple(arguments[i:i+4]) == ORIGINAL]
    if len(slots) != 1:
        raise ValueError('fixed_finite_disk_binding_changed')
    offset = slots[0]
    return [*arguments[:offset], *BOUNDED, *arguments[offset+4:]]
