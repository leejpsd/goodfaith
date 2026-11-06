-- An upheld appeal used to be recorded as a second forfeit row. It now has a kind of its own.
UPDATE "ledger_events" SET "kind" = 'upheld', "note" = NULL WHERE "kind" = 'forfeit_opened' AND "note" = 'appeal answered: upheld';
