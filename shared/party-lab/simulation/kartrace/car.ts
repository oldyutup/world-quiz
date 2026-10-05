import RAPIER from '@dimforge/rapier3d-compat';
import { CAR, HANDBRAKE, GROUP, RACE, clamp, groups, headingOf, steeringRate, yaw, type DriveInput, type Vec } from './config.js';
import type { RaceTrack, Projection } from './track.js';

/** Bowling's cheap four-ray chassis, with unrestricted physical yaw and race-local tires.
 * Rapier owns all contacts: no positional driving, scripted rams or target knockback. */
export class RaceCar {
  readonly body:RAPIER.RigidBody;
  readonly collider:RAPIER.Collider;
  grounded=false; grass=false; steer=0; heading=0; handbrake=0;
  previous:Vec={x:0,y:0,z:0}; previousHeading=0;
  projection:Projection;
  constructor(readonly world:RAPIER.World,readonly track:RaceTrack,readonly id:number,readonly maxSpeed=CAR.maxSpeed){
    const grid=track.grid(id);this.heading=grid.heading;this.previousHeading=this.heading;this.previous={...grid.p};
    this.body=world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(grid.p.x,grid.p.y,grid.p.z).setRotation(yaw(this.heading)).enabledRotations(false,true,false).setCcdEnabled(true).setCanSleep(false));
    this.collider=world.createCollider(RAPIER.ColliderDesc.roundCuboid(.98,.23,1.95,.08).setMass(CAR.mass).setFriction(.08).setRestitution(.08).setCollisionGroups(groups(GROUP.car,7)).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),this.body);
    this.projection=track.project(grid.p);
  }
  get speed(){const v=this.body.linvel();return Math.hypot(v.x,v.z);}
  get forwardSpeed(){const v=this.body.linvel();return v.x*Math.sin(this.heading)+v.z*Math.cos(this.heading);}
  place(p:Vec,heading:number){
    this.body.setTranslation(p,true);this.body.setRotation(yaw(heading),true);this.body.setLinvel({x:0,y:0,z:0},true);this.body.setAngvel({x:0,y:0,z:0},true);this.body.resetForces(true);this.body.resetTorques(true);
    this.previous={...p};this.heading=this.previousHeading=heading;this.steer=0;this.handbrake=0;this.projection=this.track.project(p);
  }
  step(input:DriveInput,locked=false){
    const dt=RACE.step,p=this.body.translation(),v=this.body.linvel();this.previous={...p};this.previousHeading=this.heading;this.heading=headingOf(this.body.rotation());this.projection=this.track.project(p);
    this.grass=this.projection.distance>this.projection.point.width/2;
    const sin=Math.sin(this.heading),cos=Math.cos(this.heading),heights:number[]=[];
    for(const z of [-1.1,1.1])for(const x of [-.6,.6]){
      const origin={x:p.x+x*cos+z*sin,y:p.y+.5,z:p.z+z*cos-x*sin};
      const hit=this.world.castRay(new RAPIER.Ray(origin,{x:0,y:-1,z:0}),1.8,true,undefined,groups(GROUP.car,GROUP.ground),undefined,this.body);
      if(hit)heights.push(origin.y-hit.timeOfImpact);
    }
    const ground=heights.length?heights.reduce((a,b)=>a+b,0)/heights.length:-100;
    this.grounded=heights.length>=2&&p.y-ground<CAR.rideHeight+.25;
    if(locked){this.body.setLinvel({x:0,y:this.grounded?v.y+clamp((ground+CAR.rideHeight-p.y)*120-v.y*18+20,0,100)*dt:v.y,z:0},true);this.body.setAngvel({x:0,y:0,z:0},true);return;}
    if(!this.grounded)return;
    const forward=v.x*sin+v.z*cos,side=v.x*cos-v.z*sin;
    const throttle=clamp(input.throttle,0,1),brake=clamp(input.brake,0,1);
    // Rear lock builds/releases over time. Tire force and yaw acceleration remain bounded.
    this.handbrake+=(Number(!!input.handbrake)-this.handbrake)*(1-Math.exp(-12*dt));
    const acceleration=this.grass?CAR.acceleration*.40:CAR.acceleration;
    const cap=this.grass?this.maxSpeed*.48:this.maxSpeed;
    let next=forward;
    if(brake>0){if(forward>.35)next=Math.max(0,forward-CAR.brake*brake*dt);else next=Math.max(-CAR.reverse,forward-acceleration*.7*brake*dt);}
    else if(throttle>0)next=forward<cap?Math.min(cap,forward+acceleration*throttle*dt):forward;
    else next=forward-Math.sign(forward)*Math.min(Math.abs(forward),CAR.coast*dt);
    // Grass slows progressively, never hard-clamps the velocity of a collision.
    if(next>cap)next-=Math.min(next-cap,(this.grass?7:2)*dt);
    else next=Math.min(cap,next);
    next-=Math.sign(next)*Math.min(Math.abs(next),HANDBRAKE.brake*this.handbrake*dt);
    const grip=this.grass?CAR.grassGrip*(1-.5*this.handbrake):CAR.grip+(HANDBRAKE.grip-CAR.grip)*this.handbrake;
    const lateral=side*Math.exp(-grip*dt);
    const vy=v.y+clamp((ground+CAR.rideHeight-p.y)*120-v.y*18+20,0,100)*dt;
    this.body.setLinvel({x:sin*next+cos*lateral,y:vy,z:cos*next-sin*lateral},true);
    this.steer+=(clamp(input.steer,-1,1)-this.steer)*(1-Math.exp(-10*dt));
    const target=this.steer*steeringRate(forward)*(forward<0?-1:1)*(this.grass?.7:1)*(1+(HANDBRAKE.yawGain-1)*this.handbrake),w=this.body.angvel().y;
    // Bounded recovery leaves real impact angular momentum visible for several frames.
    this.body.setAngvel({x:0,y:clamp(w+clamp((target-w)*(9+(HANDBRAKE.yawResponse-9)*this.handbrake),-5,5)*dt,-3,3),z:0},true);
  }
}
