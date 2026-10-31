import { Composition } from 'remotion'
import { Ad, adMetadata, SAMPLE, type AdProps } from './Ad'
import { Studio, studioMetadata, STUDIO_SAMPLE, type StudioProps } from './Studio'

export const Root = () => (
  <>
    <Composition id="Ad" component={Ad} defaultProps={SAMPLE as AdProps} calculateMetadata={adMetadata} fps={30} width={1080} height={1920} durationInFrames={450} />
    <Composition id="Studio" component={Studio} defaultProps={STUDIO_SAMPLE as StudioProps} calculateMetadata={studioMetadata} fps={30} width={1080} height={1920} durationInFrames={300} />
  </>
)
