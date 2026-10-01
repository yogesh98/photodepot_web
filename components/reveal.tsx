"use client"

import { useAnimate, useInView, useReducedMotion } from "framer-motion"
import { useEffect, type ReactNode } from "react"

export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode
  className?: string
  delay?: number
}) {
  const [scope, animate] = useAnimate<HTMLDivElement>()
  const inView = useInView(scope, { once: true, amount: 0.15 })
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    if (!inView || reduceMotion) return
    const animation = animate(
      scope.current,
      { opacity: [0, 1], y: [14, 0] },
      {
        duration: 0.65,
        delay,
        ease: [0.22, 1, 0.36, 1],
      }
    )
    return () => animation.stop()
  }, [animate, delay, inView, reduceMotion, scope])

  // Keep content visible in the server-rendered page, including without JS.
  return (
    <div ref={scope} className={className}>
      {children}
    </div>
  )
}
