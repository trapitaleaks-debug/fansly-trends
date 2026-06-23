import React from 'react'
import { Composition } from 'remotion'
import { VideoComposition, calculateMetadata } from './VideoComposition'
import type { VideoCompositionProps } from './VideoComposition'

export const RemotionRoot: React.FC = () => (
  <Composition
    id="VideoOverlay"
    component={VideoComposition}
    calculateMetadata={calculateMetadata}
    durationInFrames={150}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={
      {
        videoSrc: '',
        captionLines: [],
        brandConfig: null,
        durationSec: 5,
      } as VideoCompositionProps
    }
  />
)
