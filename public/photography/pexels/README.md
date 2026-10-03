# Pexels photography

Photographs curated for the Photodepot Daylight homepage. Source pages
and photographer credits were checked on October 2, 2026, with the bridal detail
and airplane photographs added and checked on October 3, 2026. They are used under the
[Pexels License](https://www.pexels.com/license/).

| Photograph | Photographer / source | Local web rendition | Dimensions |
| --- | --- | --- | --- |
| Portrait | [Angel Ayala](https://www.pexels.com/photo/traditional-mexican-dress-with-fan-and-floral-background-39319673/) | portrait-ayala-39319673.jpg | 1600 × 2400 |
| Bridal detail | [Alexander Mass](https://www.pexels.com/photo/elegant-bridal-hand-with-soft-focus-39904268/) | bridal-mass-39904268.jpg | 1600 × 2400 |
| Aerial | [Mohan Reddy](https://www.pexels.com/photo/airplane-among-green-trees-of-forest-4165992/) | airplane-reddy-4165992.jpg | 1920 × 2400 |
| Architecture | [Nove Jhon Pachejo](https://www.pexels.com/photo/architectural-abstract-with-modern-steel-facade-36220798/) | architecture-pachejo-36220798.jpg | 1800 × 2400 |
| Still life | [Valentin Ivantsov](https://www.pexels.com/photo/elegant-minimalist-still-life-with-vases-34902344/) | still-life-vessels-ivantsov-34902344.jpg | 1600 × 2400 |
| Underwater | [Alejandro De Roa](https://www.pexels.com/photo/scenic-underwater-cave-dive-exploration-38924949/) | underwater-de-roa-38924949.jpg | 1350 × 2400 |
| Team | [Mico Medel](https://www.pexels.com/photo/circle-of-photographers-capturing-a-subject-37061037/) | team-medel-37061037.jpg | 1920 × 2400 |

Web renditions are auto-oriented JPEG exports with a maximum dimension of 2400 px
and quality 87–88. Metadata is stripped; the original colors and compositions are
retained. CSS object positioning adapts crops to the layout. Subject labels are
written for this site, rather than the original Pexels titles.

The catalogue, alt descriptions, crop positions, and source links live in
`components/landing/photography.ts`. Each featured photograph has a visible
photographer credit linking to its Pexels source; category labels and sequence
numbers are not displayed in the captions.

The hero selects one of three distinct pairs per page load: portrait and
architecture, airplane and underwater, or bridal detail and still life.
Each of the six hero photographs appears in only one pair.

The previously supplied folder photographs are no longer served by the landing
pages. Their original files were not modified.
