"""Candidate admission reader for RevisionStore records; no installed entrypoint.

All directories and approved-review digests are protected bootstrap bindings,
never tool arguments. Publication alone grants neither a task nor a deployment.
"""
import hashlib
import json
import os
from pathlib import Path
from admission import ProtectedReview, ident, need, safe_file
from worker_parent import folder


class PublishedNodeRedReviews(ProtectedReview):
    def __init__(self, reviews, prepared, journal, approved_reviews, owner=0):
        super().__init__(reviews, owner)
        self.prepared = Path(prepared)
        self.journal = Path(journal)
        self.approved = dict(approved_reviews)
        self.identities = {}
        for p in (self.folder, self.prepared, self.journal):
            folder(p, owner)
            info = p.stat()
            self.identities[p] = (info.st_dev, info.st_ino)
        need(len(self.identities) == 3, 'publication_directories_collide')

    def document(self, parent, name, limit):
        folder(parent, self.owner)
        fd, _ = safe_file(parent / name, self.owner, 0o600, limit)
        try:
            before = os.fstat(fd)
            data = bytearray()
            while len(data) <= limit:
                block = os.read(fd, min(65536, limit + 1 - len(data)))
                if not block:
                    break
                data.extend(block)
            after = os.fstat(fd)
            fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
            need(all(getattr(before, k) == getattr(after, k) for k in fields)
                 and len(data) == before.st_size, 'publication_file_changed_during_read')
            return json.loads(data), hashlib.sha256(data).hexdigest(), [str(before.st_dev), str(before.st_ino)]
        finally:
            os.close(fd)

    def read(self, binding, principal):
        review = super().read(binding, principal)
        op = binding['operation_id']
        need(binding.get('component_id') == 'observacao_host', 'publication_component_not_admitted')
        expected = self.approved.get(op)
        ident(expected, 64)
        for p, identity in self.identities.items():
            folder(p, self.owner)
            current = p.stat()
            need((current.st_dev, current.st_ino) == identity, 'publication_directory_replaced')
            need(not os.path.lexists(p / 'revoked'), 'publication_access_revoked')
        receipt, _, _ = self.document(self.journal / op, 'receipt.json', 16384)
        fields = {'operation_id', 'review_sha256', 'state', 'output_sha256',
                  'output_identities', 'automatic_retry'}
        need(type(receipt) is dict and set(receipt) == fields
             and receipt['operation_id'] == op and receipt['review_sha256'] == expected
             and receipt['state'] == 'protected_records_published_not_deployed'
             and receipt['automatic_retry'] is False, 'publication_receipt_unconfirmed')
        hashes, identities = receipt['output_sha256'], receipt['output_identities']
        need(type(hashes) is list and type(identities) is list
             and len(hashes) == len(identities) == 4, 'publication_receipt_shape')
        order = ((self.prepared, 'apply'), (self.prepared, 'rollback'),
                 (self.folder, 'rollback'), (self.folder, 'apply'))
        for i, (parent, action) in enumerate(order):
            ident(hashes[i], 64)
            _, digest, identity = self.document(parent, op + '-' + action + '.json', 1048576 + 8192)
            need(digest == hashes[i] and identity == identities[i], 'published_record_changed')
        # The review already read by the base class must be the exact published
        # review too. A subsequent replacement cannot lend it another receipt.
        published, _, _ = self.document(self.folder, op + '-' + binding['action'] + '.json', 16384)
        need(review == published, 'review_changed_during_publication_check')
        return review
