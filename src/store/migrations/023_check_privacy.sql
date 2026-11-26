-- Check outputs and raw error text are no longer kept (docs/spec.md 4.6): only the comparison
-- hash and sanitized failure metadata persist. Clear what earlier versions stored; the columns
-- stay so old fixtures can still seed them, but nothing reads them any more.
UPDATE reminders SET check_output = NULL, check_error = NULL WHERE check_command IS NOT NULL;
