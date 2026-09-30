## Summary

<!-- What changes, and which issue it closes. -->

## Testing

<!-- What you ran, and what it showed. Say what CI cannot cover. -->

## Parser changes only

If this changes `src/parsers/`, the parsed-document contracts (`parsed-documents.mjs`, `value-state.mjs`) or the capture manifest, CI requires the line below. The real Sports Reference captures are not in the repository, so CI skips the tests that read them; `npm run parsers:verify` runs them on a machine that has the captures and prints the line.

- [ ] I ran `npm run parsers:verify` against the real captures and pasted its line here (delete this section if the change touches no parser):

```
Real-capture verification: passed (captures ..., parsers ..., ... tests, ...)
```
