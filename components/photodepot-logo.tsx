import Image from "next/image"

export function PhotodepotLogo() {
  return (
    <Image
      src="/brand/photodepot-lockup.svg"
      alt=""
      width={625}
      height={169}
      loading="eager"
    />
  )
}
