type Photograph = {
  id: string
  src: string
  width: number
  height: number
  label: string
  alt: string
  position: string
  photographer: string
  source: string
}

export const photographs = [
  {
    id: "portrait-ayala-39319673",
    src: "/photography/pexels/portrait-ayala-39319673.jpg",
    width: 1600,
    height: 2400,
    label: "Portrait",
    alt: "A woman in traditional Mexican dress holding a decorative fan beneath colorful flowers.",
    position: "50% 50%",
    photographer: "Angel Ayala",
    source:
      "https://www.pexels.com/photo/traditional-mexican-dress-with-fan-and-floral-background-39319673/",
  },
  {
    id: "bridal-mass-39904268",
    src: "/photography/pexels/bridal-mass-39904268.jpg",
    width: 1600,
    height: 2400,
    label: "Bridal detail",
    alt: "Close-up of a bride’s manicured hand resting on a white wedding dress, with her other hand softly out of focus.",
    position: "50% 50%",
    photographer: "Alexander Mass",
    source:
      "https://www.pexels.com/photo/elegant-bridal-hand-with-soft-focus-39904268/",
  },
  {
    id: "airplane-reddy-4165992",
    src: "/photography/pexels/airplane-reddy-4165992.jpg",
    width: 1920,
    height: 2400,
    label: "Aerial",
    alt: "Aerial view of a white airplane surrounded by dense green trees.",
    position: "50% 50%",
    photographer: "Mohan Reddy",
    source:
      "https://www.pexels.com/photo/airplane-among-green-trees-of-forest-4165992/",
  },
  {
    id: "architecture-pachejo-36220798",
    src: "/photography/pexels/architecture-pachejo-36220798.jpg",
    width: 1800,
    height: 2400,
    label: "Architecture",
    alt: "Black-and-white photograph of angular steel facades rising against a cloudy sky.",
    position: "50% 50%",
    photographer: "Nove Jhon Pachejo",
    source:
      "https://www.pexels.com/photo/architectural-abstract-with-modern-steel-facade-36220798/",
  },
  {
    id: "still-life-vessels-ivantsov-34902344",
    src: "/photography/pexels/still-life-vessels-ivantsov-34902344.jpg",
    width: 1600,
    height: 2400,
    label: "Still life",
    alt: "White sculptural vases, cylinders, and a cube arranged on deep teal fabric against a textured dark green backdrop.",
    position: "50% 58%",
    photographer: "Valentin Ivantsov",
    source:
      "https://www.pexels.com/photo/elegant-minimalist-still-life-with-vases-34902344/",
  },
  {
    id: "underwater-de-roa-38924949",
    src: "/photography/pexels/underwater-de-roa-38924949.jpg",
    width: 1350,
    height: 2400,
    label: "Underwater",
    alt: "A split-level view of a rocky cave arch above clear blue water and a diver exploring beneath the surface.",
    position: "50% 50%",
    photographer: "Alejandro De Roa",
    source:
      "https://www.pexels.com/photo/scenic-underwater-cave-dive-exploration-38924949/",
  },
] satisfies Photograph[]

export const collaborationPhotograph = {
  id: "team-medel-37061037",
  src: "/photography/pexels/team-medel-37061037.jpg",
  width: 1920,
  height: 2400,
  label: "Team",
  alt: "A circle of photographers pointing their cameras toward the center, viewed from below against a blue sky.",
  position: "50% 50%",
  photographer: "Mico Medel",
  source:
    "https://www.pexels.com/photo/circle-of-photographers-capturing-a-subject-37061037/",
} satisfies Photograph
