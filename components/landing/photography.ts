type Photograph = {
  id: string
  src: string
  label: string
  alt: string
  position: string
  photographer: string
  source: string
}

export const photographs = [
  {
    id: "portrait-emiliano-30760594",
    src: "/photography/pexels/portrait-emiliano-30760594.jpg",
    label: "Portrait",
    alt: "Close portrait of a woman framing her face with her hands under red, green, and cool blue light.",
    position: "50% 50%",
    photographer: "Emiliano LG",
    source:
      "https://www.pexels.com/photo/expressive-portrait-with-colorful-lighting-effects-30760594/",
  },
  {
    id: "movement-koolshooters-7673778",
    src: "/photography/pexels/movement-koolshooters-7673778.jpg",
    label: "Movement",
    alt: "A male contemporary dancer suspended above the floor with curved arms, against a cyan wall and a red circle of projected light.",
    position: "50% 50%",
    photographer: "KoolShooters",
    source:
      "https://www.pexels.com/photo/man-standing-in-a-dancing-position-beside-a-blue-wall-7673778/",
  },
  {
    id: "detail-buyukkilinc-32070697",
    src: "/photography/pexels/detail-buyukkilinc-32070697.jpg",
    label: "Detail",
    alt: "Black-and-white photograph of two hands reaching toward one another from black and white jacket sleeves against a textured dark wall.",
    position: "50% 75%",
    photographer: "Burak Bahadır Büyükkılınç",
    source:
      "https://www.pexels.com/photo/black-and-white-artistic-hands-reaching-out-32070697/",
  },
  {
    id: "street-shadow-rayner-19796996",
    src: "/photography/pexels/street-shadow-rayner-19796996.jpg",
    label: "Street",
    alt: "A solitary pedestrian beside a brick wall on a sunlit London sidewalk, photographed in black and white with long shadows.",
    position: "52% 43%",
    photographer: "Helen Rayner",
    source:
      "https://www.pexels.com/photo/person-walking-on-sunlit-sidewalk-in-black-and-white-19796996/",
  },
  {
    id: "city-rain-london-31667360",
    src: "/photography/pexels/city-rain-london-31667360.jpg",
    label: "Night",
    alt: "A person under an umbrella crossing a rain-soaked Tokyo street with amber storefront light reflected on the pavement.",
    position: "50% 62%",
    photographer: "Alexander London",
    source:
      "https://www.pexels.com/photo/moody-night-scene-in-tokyo-s-streets-31667360/",
  },
  {
    id: "architecture-terracotta-percheron-29062920",
    src: "/photography/pexels/architecture-terracotta-percheron-29062920.jpg",
    label: "Architecture",
    alt: "A terracotta-colored modern facade and long glass windows rising diagonally against a pale sky.",
    position: "50% 50%",
    photographer: "Clément Percheron",
    source:
      "https://www.pexels.com/photo/modern-minimalist-architecture-with-red-facade-29062920/",
  },
  {
    id: "still-life-vessels-ivantsov-34902344",
    src: "/photography/pexels/still-life-vessels-ivantsov-34902344.jpg",
    label: "Still life",
    alt: "White sculptural vases, cylinders, and a cube arranged on deep teal fabric against a textured dark green backdrop.",
    position: "50% 58%",
    photographer: "Valentin Ivantsov",
    source:
      "https://www.pexels.com/photo/elegant-minimalist-still-life-with-vases-34902344/",
  },
] satisfies Photograph[]
