# Test databases

`GeoLite2-City-Test.mmdb` and `GeoLite2-ASN-Test.mmdb` are MaxMind's test databases, taken from the `test-data` directory of [maxmind/MaxMind-DB](https://github.com/maxmind/MaxMind-DB) at commit [`0ee49278e35fd7bdf341ac236edbba20de1aceb9`](https://github.com/maxmind/MaxMind-DB/tree/0ee49278e35fd7bdf341ac236edbba20de1aceb9/test-data). They hold a small set of made-up records. The JSON they were built from, which lists every network in them, is in the [`source-data`](https://github.com/maxmind/MaxMind-DB/tree/0ee49278e35fd7bdf341ac236edbba20de1aceb9/source-data) directory at the same commit.

The tests use these addresses:

| Address | City edition | ASN edition |
| ------- | ------------ | ----------- |
| `89.160.20.112` | Linköping, Sweden | 29518, Bredband2 AB |
| `2001:480::1` | San Diego, United States | none |
| `1.128.0.1` | none | 1221, Telstra Pty Ltd |
| `10.0.0.1` | none | none |

To update the files, download both from a newer commit, replace them here, update the commit above, and adjust the expected values in the tests if the records changed.

Copyright (c) 2013 - 2026 by MaxMind, Inc. The databases are licensed under the [Apache License, Version 2.0](https://github.com/maxmind/MaxMind-DB/blob/0ee49278e35fd7bdf341ac236edbba20de1aceb9/LICENSE-APACHE) or the MIT License, at your option. They are used here under the MIT License, whose text is in [LICENSE-MIT](LICENSE-MIT).
