"""Additive read-only broker entry point; existing operations stay unchanged."""
import operations
import maintenance_diagnostics as diagnostics

class DiagnosticBroker(operations.Broker):
    def handle(self, name, args):
        if name in diagnostics.FIELDS:
            return diagnostics.handle(self, name, args)
        return super().handle(name, args)

if __name__ == '__main__':
    operations.Broker = DiagnosticBroker
    operations.FIELDS.update(diagnostics.FIELDS)
    operations.main()
